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
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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

    // 5. 报价员自动学习：从完成订单导入训练数据
    let trainingSync = { imported: 0, skipped: 0 };
    try {
      const { syncOrdersToTraining } = await import('@/app/actions/quoter-training');
      trainingSync = await syncOrdersToTraining();
    } catch (e: any) {
      console.error('[nightly-maintenance] training sync error:', e?.message);
    }

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
    });
  } catch (err: any) {
    console.error('[nightly-maintenance]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
