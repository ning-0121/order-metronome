import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 每日数据备份 —— R1-A Disaster Recovery 重写(2026-08-07)。
 *
 * 【旧版为什么从未产出过一份备份】(体检 P0:backups 桶自始至终是空的)
 *   1. cron 触发时用无登录态的 session 客户端 → 每张表被 RLS 拒读、上传被存储策略拒,
 *      每天 500/空转,无人告警;
 *   2. `.limit(10000)` 是自欺 —— PostgREST 单次最多 1000 行,3979 条节点只会备份 1000 条,
 *      就算跑通也是一份**撒谎的备份**;
 *   3. 只看上传调用的返回,从不回读验证文件真的存在、内容真的非空。
 *
 * 【本版原则】THE SYSTEM MUST NOT LIE:
 *   - 读/写全部 service-role(手动触发仍先验管理员身份);
 *   - 每表分页取全量,备份内记录每表行数;核心表(orders/milestones/profiles)读失败或 0 行
 *     = 整体 FAILED,绝不上传一份缺芯的"成功备份";
 *   - 上传后**回读下载**同一文件,解析并断言核心表非 0、字节数达标 —— 验收的是产物,不是动作;
 *   - 每次运行落 automation_runs 台账(health 按业务结果判);FAILED 时通知全体 admin;
 *   - 表不存在记为 skipped(明示),不伪装成 0 行。
 */

// 核心表:任何一张读失败或 0 行 → 备份整体 FAILED(空库不可能,0 行只可能是读挂了)
const CORE_TABLES = ['orders', 'milestones', 'profiles'] as const;

// 全量备份清单(2026-08-07 按当前业务扩充;不存在的表会被记为 skipped)
const BACKUP_TABLES = [
  'orders', 'milestones', 'profiles',
  'milestone_logs', 'order_logs',
  'delay_requests', 'po_overdue_waivers', 'order_amendments',
  'order_line_items', 'order_financials', 'order_commissions',
  'purchase_orders', 'procurement_line_items', 'procurement_items',
  'material_resupply_requests', 'qc_inspections',
  'order_attachments', 'customer_memory', 'customers', 'factories',
  'notifications', 'runtime_orders',
];

const PAGE = 1000;

/** 分页取全量 —— PostgREST 单次上限 1000 行,不翻页 = 静默截断(本项目血泪教训) */
async function fetchAll(svc: any, table: string): Promise<{ rows?: any[]; error?: string }> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (svc.from(table) as any)
      .select('*').range(from, from + PAGE - 1);
    if (error) return { error: error.message };
    rows.push(...(data || []));
    if ((data || []).length < PAGE) break;
    if (rows.length > 200_000) return { error: `超出 20 万行保护上限(${table})` };
  }
  return { rows };
}

export async function POST(request: Request) {
  const startedAt = new Date();
  const runId = `backup_${startedAt.toISOString().replace(/[:.]/g, '-')}`;

  // ── 鉴权:cron secret 或 管理员 session(仅鉴权用 session,数据读写一律 service-role)──
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const session = await createClient();
    const { data: { user } } = await session.auth.getUser();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const { data: profile } = await (session.from('profiles') as any)
      .select('role, roles').eq('user_id', user.id).single();
    const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
    if (!roles.includes('admin')) {
      return NextResponse.json({ error: '仅管理员可执行备份' }, { status: 403 });
    }
  }

  const svc = createServiceRoleClient();

  // 台账:先落 running(失败也留痕 —— 假健康的反面是"连失败都有记录")
  const { data: runRow } = await (svc.from('automation_runs') as any).insert({
    job_name: 'backup', run_id: runId, started_at: startedAt.toISOString(),
    status: 'running', expected_min_output: 'artifacts>=1 且 orders/milestones/profiles 均>0 且回读验证通过',
  }).select('id').maybeSingle();
  const runDbId = (runRow as any)?.id;

  const finish = async (patch: Record<string, any>) => {
    if (!runDbId) return;
    await (svc.from('automation_runs') as any)
      .update({ finished_at: new Date().toISOString(), ...patch }).eq('id', runDbId);
  };

  const fail = async (code: string, message: string, extra?: Record<string, any>) => {
    console.error(`[backup] FAILED ${code}: ${message}`);
    await finish({ status: 'failed', health_status: 'failed', error_code: code, error_message: message.slice(0, 500), metadata: extra || null });
    // FAILED 必须有人知道 —— 通知全体 admin(service-role 写,统一入口)
    try {
      const { data: admins } = await (svc.from('profiles') as any)
        .select('user_id').or('role.eq.admin,roles.cs.{admin}');
      const { insertNotifications } = await import('@/lib/utils/notifications');
      await insertNotifications(((admins || []) as any[]).map((a) => ({
        user_id: a.user_id, type: 'backup_failed',
        title: '🔴 每日备份失败 — 灾备缺口',
        message: `备份任务失败(${code}):${message.slice(0, 200)}。在修复前系统没有新的冷备。`,
      })));
    } catch (e: any) { console.error('[backup] 失败告警也没发出去:', e?.message); }
    return NextResponse.json({ success: false, error: `${code}: ${message}` }, { status: 500 });
  };

  try {
    // ── ① 逐表全量导出 ──
    const backupData: Record<string, any[]> = {};
    const stats: Record<string, number> = {};
    const skipped: Record<string, string> = {};
    let rowsRead = 0;
    for (const table of BACKUP_TABLES) {
      const { rows, error } = await fetchAll(svc, table);
      if (error) {
        // 核心表读失败 = 整体失败;非核心表明示 skipped,绝不伪装成 0 行
        if ((CORE_TABLES as readonly string[]).includes(table)) {
          return await fail('CORE_TABLE_READ_FAILED', `核心表 ${table} 读取失败: ${error}`);
        }
        skipped[table] = error;
        continue;
      }
      backupData[table] = rows!;
      stats[table] = rows!.length;
      rowsRead += rows!.length;
    }
    for (const t of CORE_TABLES) {
      if (!stats[t] || stats[t] === 0) {
        return await fail('CORE_TABLE_EMPTY', `核心表 ${t} 备份到 0 行 —— 生产不可能是空的,判定读取异常,拒绝产出撒谎的备份`);
      }
    }

    // ── ② 上传 ──
    const dateStr = startedAt.toISOString().slice(0, 10);
    const timeStr = startedAt.toISOString().slice(11, 19).replace(/:/g, '-');
    const fileName = `daily/${dateStr}_${timeStr}.json`;
    const backupJson = JSON.stringify({
      version: '4.0-r1a', created_at: startedAt.toISOString(), stats, skipped, tables: backupData,
    });
    const { error: uploadError } = await svc.storage.from('backups')
      .upload(fileName, backupJson, { contentType: 'application/json', upsert: true });
    if (uploadError) return await fail('UPLOAD_FAILED', uploadError.message, { stats });

    // ── ③ 回读验证:验收的是产物,不是动作 ──
    const { data: blob, error: dlError } = await svc.storage.from('backups').download(fileName);
    if (dlError || !blob) return await fail('READBACK_DOWNLOAD_FAILED', dlError?.message || '回读为空', { fileName });
    const readBytes = blob.size;
    if (readBytes < 100_000) {
      return await fail('READBACK_TOO_SMALL', `回读文件仅 ${readBytes} 字节(阈值 100KB)`, { fileName });
    }
    let parsed: any;
    try { parsed = JSON.parse(await blob.text()); }
    catch { return await fail('READBACK_UNPARSABLE', '回读文件不是合法 JSON', { fileName }); }
    for (const t of CORE_TABLES) {
      const n = Array.isArray(parsed?.tables?.[t]) ? parsed.tables[t].length : 0;
      if (n === 0) return await fail('READBACK_CORE_EMPTY', `回读后核心表 ${t} 为 0 行`, { fileName });
      if (n !== stats[t]) return await fail('READBACK_COUNT_MISMATCH', `回读 ${t}=${n} 行 ≠ 导出 ${stats[t]} 行`, { fileName });
    }

    // ── ④ 保留期清理(30 天)──
    const thirtyDaysAgo = new Date(startedAt.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: oldFiles } = await svc.storage.from('backups').list('daily', { limit: 200 });
    const toDelete = (oldFiles || []).filter((f) => f.name.slice(0, 10) < thirtyDaysAgo).map((f) => `daily/${f.name}`);
    if (toDelete.length) await svc.storage.from('backups').remove(toDelete);

    // ── ⑤ 台账收尾 ──
    const durationMs = Date.now() - startedAt.getTime();
    await finish({
      status: 'success', health_status: 'healthy',
      rows_read: rowsRead, rows_written: null, artifacts_created: 1, notifications_created: 0,
      metadata: { file: fileName, bytes: readBytes, duration_ms: durationMs, stats, skipped },
    });

    return NextResponse.json({
      success: true, verified: true,
      file: fileName, bytes: readBytes, durationMs,
      stats, skipped,
      totalRecords: rowsRead,
    });
  } catch (err: any) {
    return await fail('UNEXPECTED', err?.message || String(err));
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vercel Cron 用 GET 触发(2026-07-28 教训:只有 POST 时,cron 405 了几个月)
export async function GET(req: Request) { return POST(req); }
