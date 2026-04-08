'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { runSystemGuardian } from '@/lib/agent/systemGuardian';
import { createClient as createAdminClient } from '@supabase/supabase-js';

/**
 * 管理员手动触发系统守护（立即运行一次）
 */
export async function runSystemGuardianNow(): Promise<{
  error?: string;
  report?: any;
}> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限：仅管理员可手动触发' };

  // 用 service_role 跑，避免 RLS 拦截检查
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { error: '系统配置错误：缺少 SERVICE_ROLE_KEY' };

  try {
    const adminClient = createAdminClient(url, serviceKey);
    const report = await runSystemGuardian(adminClient, {
      autoFix: true,
      withMetaReview: true,
    });

    // 保存到 system_health_reports
    const { data: saved, error: saveErr } = await (adminClient.from('system_health_reports') as any)
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
      .select('*')
      .single();

    if (saveErr) return { error: '保存报告失败：' + saveErr.message };

    return { report: saved };
  } catch (e: any) {
    return { error: '运行失败：' + (e?.message || e) };
  }
}
