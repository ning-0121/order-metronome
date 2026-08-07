/**
 * 备份健康哨兵 —— R1-A(2026-08-07)。
 *
 * 旧备份 cron 空转了几个月没人发现,因为从来没人**盯着产物**。
 * 本哨兵每晚跑(挂 nightly-maintenance),只看两样东西,全是产物不是动作:
 *   ① automation_runs 里 24 小时内有没有 status='success' 的 backup 运行
 *      → 没有 = CRITICAL(备份断供,灾备缺口在扩大)
 *   ② 存储里最新备份文件本体:0 字节、下载失败、或核心表 0 行 = FAILED
 *      (有台账说成功但文件是坏的 —— 台账也可能撒谎,以文件为准)
 *
 * 任何非 healthy 结果 → 通知全体 admin。哨兵自身失败也算 CRITICAL(不许静默)。
 */

export interface BackupHealthResult {
  status: 'healthy' | 'critical' | 'failed';
  reason: string;
  latestFile?: string;
  latestBytes?: number;
  lastSuccessAt?: string | null;
}

const CORE_TABLES = ['orders', 'milestones', 'profiles'];

export async function checkBackupHealth(svc: any): Promise<BackupHealthResult> {
  // ① 24 小时内有成功运行吗(看台账)
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: runs, error: runErr } = await (svc.from('automation_runs') as any)
    .select('started_at, status')
    .eq('job_name', 'backup').eq('status', 'success')
    .gte('started_at', dayAgo)
    .order('started_at', { ascending: false }).limit(1);
  if (runErr) return { status: 'critical', reason: `无法读取备份台账:${runErr.message}` };
  const lastSuccessAt = (runs as any[])?.[0]?.started_at ?? null;
  if (!lastSuccessAt) {
    return { status: 'critical', reason: '24 小时内没有一次成功备份 —— 灾备断供中', lastSuccessAt: null };
  }

  // ② 最新文件本体抽检(台账说成功不算数,文件说了算)
  const { data: files, error: listErr } = await svc.storage.from('backups')
    .list('daily', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
  if (listErr || !files?.length) {
    return { status: 'failed', reason: `台账说成功但存储里列不到备份文件(${listErr?.message || '空目录'})`, lastSuccessAt };
  }
  const latest = files[0];
  const path = `daily/${latest.name}`;
  const { data: blob, error: dlErr } = await svc.storage.from('backups').download(path);
  if (dlErr || !blob) return { status: 'failed', reason: `最新备份 ${path} 下载失败:${dlErr?.message || '空'}`, latestFile: path, lastSuccessAt };
  if (blob.size < 100_000) {
    return { status: 'failed', reason: `最新备份 ${path} 仅 ${blob.size} 字节(阈值 100KB)`, latestFile: path, latestBytes: blob.size, lastSuccessAt };
  }
  try {
    const parsed = JSON.parse(await blob.text());
    for (const t of CORE_TABLES) {
      const n = Array.isArray(parsed?.tables?.[t]) ? parsed.tables[t].length : 0;
      if (n === 0) return { status: 'failed', reason: `最新备份 ${path} 核心表 ${t} 为 0 行`, latestFile: path, latestBytes: blob.size, lastSuccessAt };
    }
  } catch {
    return { status: 'failed', reason: `最新备份 ${path} 不是合法 JSON`, latestFile: path, latestBytes: blob.size, lastSuccessAt };
  }

  return { status: 'healthy', reason: '24h 内有成功备份,最新文件回读校验通过', latestFile: path, latestBytes: blob.size, lastSuccessAt };
}

/** 跑哨兵并在非 healthy 时通知全体 admin。返回结果供夜维报告聚合。 */
export async function runBackupHealthSentinel(svc: any): Promise<BackupHealthResult> {
  let r: BackupHealthResult;
  try {
    r = await checkBackupHealth(svc);
  } catch (e: any) {
    r = { status: 'critical', reason: `哨兵自身异常:${e?.message}` };
  }
  if (r.status !== 'healthy') {
    try {
      const { data: admins } = await (svc.from('profiles') as any)
        .select('user_id').or('role.eq.admin,roles.cs.{admin}');
      const { insertNotifications } = await import('@/lib/utils/notifications');
      await insertNotifications(((admins || []) as any[]).map((a) => ({
        user_id: a.user_id, type: 'backup_health',
        title: r.status === 'critical' ? '🔴 备份健康 CRITICAL' : '🔴 备份健康 FAILED',
        message: `${r.reason}${r.latestFile ? ` | 最新文件 ${r.latestFile}` : ''}${r.lastSuccessAt ? ` | 上次成功 ${r.lastSuccessAt}` : ''}`,
      })));
    } catch (e: any) { console.error('[backup-health] 告警发送失败:', e?.message); }
  }
  console.log(`[backup-health] ${r.status}: ${r.reason}`);
  return r;
}
