/**
 * 每晚系统维护 — 北京时间 22:00
 *
 * 调用 SystemGuardian 跑 6 个维度的健康检查：
 *   1. 安全性
 *   2. 稳定性
 *   3. 节拍器准确性
 *   4. 时间准确性
 *   5. 权限稳定性
 *   6. AI 进化稳定性
 *
 * 结果：
 *   - 写入 system_health_reports 表
 *   - 有问题时通知 admin（站内 + 微信）
 *   - 可自动修复的问题自动修复
 *   - AI 元审视层给出人类视角的总结
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { runSystemGuardian, formatReportAsText } from '@/lib/agent/systemGuardian';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey)
      return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);

    // 1. 跑 Guardian（autoFix + metaReview 都开）
    const report = await runSystemGuardian(supabase, {
      autoFix: true,
      withMetaReview: true,
    });

    // 2. 写入 system_health_reports 表
    const { data: saved, error: saveErr } = await (supabase.from('system_health_reports') as any)
      .insert({
        ran_at: report.ranAt,
        took_ms: report.tookMs,
        total_checks: report.totalChecks,
        passed_count: report.passedCount,
        warning_count: report.warningCount,
        critical_count: report.criticalCount,
        auto_fixed_count: report.autoFixedCount,
        checks: report.checks,
        meta_review: report.metaReview,
      })
      .select('id')
      .single();
    if (saveErr) console.error('[nightly-maintenance] 保存报告失败:', saveErr.message);

    // 3. 通知管理员（只有 warning/critical 才推）
    const needsNotify = report.warningCount + report.criticalCount > 0;
    if (needsNotify) {
      const { data: admins } = await supabase
        .from('profiles')
        .select('user_id, wechat_push_key')
        .or('role.eq.admin,roles.cs.{admin}');

      const reportText = formatReportAsText(report);
      const title = `🛡 系统守护 — ${report.criticalCount > 0 ? `🔴 ${report.criticalCount} 严重` : `⚠ ${report.warningCount} 警告`}`;

      for (const admin of (admins || []) as any[]) {
        await supabase.from('notifications').insert({
          user_id: admin.user_id,
          type: 'system_health',
          title,
          message: reportText.slice(0, 1000),
          status: 'unread',
        });

        if (admin.wechat_push_key) {
          try {
            const { sendWechatPush } = await import('@/lib/utils/wechat-push');
            await sendWechatPush(admin.wechat_push_key, title, reportText);
          } catch {}
        }
      }
    }

    // 4. 清理：删除 90 天前的旧报告
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    await (supabase.from('system_health_reports') as any)
      .delete()
      .lt('ran_at', ninetyDaysAgo);

    // 4b. 通知保留期 —— notifications 表建库以来只进不出，2026-08-05 已涨到
    //     53,543 条 / 31 MB（全库最大），其中 86% 是早就删掉的功能刷出来的死数据。
    //     清完一次不算完，没有保留期一定复发，所以变成每晚例行。详见 lib 文件头。
    let retention: any = null;
    try {
      const { runNotificationRetention, formatRetentionResult } =
        await import('@/lib/maintenance/notification-retention');
      const rr = await runNotificationRetention(supabase);
      retention = rr;
      // 只有刷屏或出错才打扰 admin，日常静默
      if (rr.flooding || rr.errors.length) {
        const { data: admins } = await supabase
          .from('profiles').select('user_id').or('role.eq.admin,roles.cs.{admin}');
        for (const a of (admins || []) as any[]) {
          await supabase.from('notifications').insert({
            user_id: a.user_id,
            type: 'system_health',
            title: rr.flooding ? '⚠️ 通知表异常增长' : '通知清理出错',
            message: formatRetentionResult(rr).slice(0, 1000),
            status: 'unread',
          });
        }
      }
      console.log('[nightly-maintenance] 通知保留期:', formatRetentionResult(rr));
    } catch (e: any) {
      // 清理失败不能把整个夜间维护带崩
      console.error('[nightly-maintenance] 通知保留期失败（不阻断）:', e?.message);
    }

    // 4c. 备份健康哨兵(R1-A,2026-08-07)—— 旧备份空转数月无人发现的根治:
    //     每晚验产物(24h 内有成功运行 + 最新文件回读非空非 0 行),非 healthy 直接告警 admin。
    let backupHealth: any = null;
    try {
      const { runBackupHealthSentinel } = await import('@/lib/maintenance/backup-health');
      backupHealth = await runBackupHealthSentinel(supabase);
    } catch (e: any) {
      console.error('[nightly-maintenance] 备份哨兵失败（不阻断）:', e?.message);
    }

    // 4d. Automation Watchdog(R1-B,2026-08-08)—— 核对 backup/daily/order-audit/daily-briefing
    //     的业务产出:沉默超时、跑了但零产出、二连败,全部按规则告警(带 20h 去重)。
    //     watchdog 自己也写 automation_runs,失败在此处 console + 下方 metaReview 可见。
    let watchdog: any = null;
    try {
      const { runAutomationWatchdog } = await import('@/lib/automation/watchdog');
      watchdog = await runAutomationWatchdog(supabase);
    } catch (e: any) {
      console.error('[nightly-maintenance] watchdog 失败（不阻断）:', e?.message);
      watchdog = { error: e?.message };
    }

    // 5. ~~报价员自动学习~~ —— 报价器 2026-08-01 下线(CEO 拍板),此步随之移除。
    //    原逻辑:从完成订单导入 quoter_training_feedback。该表 0 行,报价器四张表全空、
    //    四个页面零使用,整条报价链已删除。保留字段名只为让返回结构不变(下游可能在看)。
    const trainingSync = { imported: 0, skipped: 0 };

    return NextResponse.json({
      success: true,
      reportId: (saved as any)?.id,
      summary: {
        total: report.totalChecks,
        passed: report.passedCount,
        warning: report.warningCount,
        critical: report.criticalCount,
        autoFixed: report.autoFixedCount,
        metaReview: report.metaReview?.summary,
      },
      retention,
      backupHealth,
      watchdog,
    });
  } catch (err: any) {
    console.error('[nightly-maintenance]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
