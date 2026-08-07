/**
 * Automation Outcome Health Layer —— R1-B(2026-08-08)。
 *
 * 最高原则:A JOB IS NOT HEALTHY BECAUSE IT RAN.
 *          A JOB IS HEALTHY ONLY IF ITS EXPECTED BUSINESS OUTCOME OCCURRED.
 *
 * 【为什么要有这一层】体检实锤三个"绿灯尸体":备份 cron 从未产出文件、
 * /api/cron/daily 四步用无登录客户端空转数月、order-audit 通知停发 73 天 ——
 * 共同点是每个 cron 自己随口定义"成功"(HTTP 200 / 没抛异常),没人看业务产出。
 *
 * 【契约】所有自动任务经 runAutomationJob() 执行:
 *   - 每次运行落 automation_runs 一行(running → 终态),失败也留痕
 *   - health 由**业务结果**判定,与 HTTP 状态无关:
 *       eligible>0 且 processed=0        → failed/critical(该干的活一件没干)
 *       eligible=0 且 processed=0        → success/healthy + no_work(没活干是正常)
 *       部分失败 / 步骤 silent-zero      → degraded/warning
 *       关键步骤 DB error / 抛异常       → failed/critical
 *   - 失败自动重试 1 次(retry_of_run_id 关联;写路径必须幂等,由各 job 自证)
 *   - 二连败 → critical;告警只发 admin,同 job+指纹 6 小时冷却窗口内合并,防风暴
 *
 * 未来 Executive OS 的一切自主执行动作都必须过这层 —— 系统不能在动作
 * 没有真实完成时说"成功"。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';

export interface JobStepResult {
  step: string;
  eligible?: number | null;
  processed?: number | null;
  written?: number | null;
  failed?: number | null;
  duration_ms?: number;
  error?: string | null;
  /** 关键步骤:出 DB error 时整个 job 判 failed(而不只是 degraded) */
  critical?: boolean;
}

export interface JobOutcome {
  steps?: JobStepResult[];
  eligible?: number | null;
  processed?: number | null;
  rowsRead?: number; rowsWritten?: number; rowsUpdated?: number; rowsDeleted?: number;
  artifacts?: number; notificationsCreated?: number;
  failedItems?: number; skippedItems?: number;
  errorCode?: string; errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export type JobHealth = 'healthy' | 'warning' | 'critical';
export type JobStatus = 'success' | 'degraded' | 'failed' | 'skipped';

/** 纯函数:按业务结果判定 status/health(可测,阈值别绕过测试改) */
export function computeJobHealth(o: JobOutcome): { status: JobStatus; health: JobHealth; reasons: string[] } {
  const reasons: string[] = [];

  // 显式错误 → failed
  if (o.errorCode) {
    return { status: 'failed', health: 'critical', reasons: [`${o.errorCode}: ${o.errorMessage || ''}`] };
  }

  let degraded = false;
  for (const s of o.steps || []) {
    if (s.error) {
      if (s.critical) return { status: 'failed', health: 'critical', reasons: [`关键步骤 ${s.step} 失败: ${s.error}`] };
      degraded = true; reasons.push(`步骤 ${s.step} 失败: ${s.error}`);
    }
    // silent-zero:有活干却一件没干成
    const done = s.processed ?? s.written ?? null;
    if ((s.eligible ?? 0) > 0 && done === 0) {
      degraded = true; reasons.push(`步骤 ${s.step} silent-zero: eligible=${s.eligible} 但产出 0`);
    }
    if ((s.failed ?? 0) > 0) { degraded = true; reasons.push(`步骤 ${s.step} 部分失败 ${s.failed} 项`); }
  }

  const eligible = o.eligible ?? null;
  const processed = o.processed ?? null;
  if (eligible !== null && processed !== null) {
    if (eligible > 0 && processed === 0) {
      return { status: 'failed', health: 'critical', reasons: [`eligible=${eligible} 但 processed=0(该干的活一件没干)`, ...reasons] };
    }
    if (eligible === 0 && processed === 0 && !degraded) {
      return { status: 'success', health: 'healthy', reasons: ['no_work(没有符合条件的对象,属正常)'] };
    }
  }
  if ((o.failedItems ?? 0) > 0) { degraded = true; reasons.push(`失败项 ${o.failedItems}`); }

  return degraded
    ? { status: 'degraded', health: 'warning', reasons }
    : { status: 'success', health: 'healthy', reasons };
}

/** 告警去重:同 job+指纹在冷却窗内只发一次(防通知风暴) */
export async function notifyAutomationHealth(
  svc: any, jobName: string, health: JobHealth, fingerprint: string, detail: string,
  cooldownHours = 6,
): Promise<number> {
  if (health === 'healthy') return 0;
  const fpTag = `[${jobName}:${fingerprint}]`;
  const since = new Date(Date.now() - cooldownHours * 3600_000).toISOString();
  const { data: dup } = await (svc.from('notifications') as any)
    .select('id').eq('type', 'automation_health')
    .ilike('message', `%${fpTag}%`).gte('created_at', since).limit(1);
  if (dup?.length) return 0;   // 冷却窗内已发过同款,合并

  const { data: admins } = await (svc.from('profiles') as any)
    .select('user_id').or('role.eq.admin,roles.cs.{admin}');
  const { insertNotifications } = await import('@/lib/utils/notifications');
  const rows = ((admins || []) as any[]).map((a) => ({
    user_id: a.user_id, type: 'automation_health',
    title: health === 'critical' ? `🔴 自动化 CRITICAL:${jobName}` : `⚠️ 自动化降级:${jobName}`,
    message: `${fpTag} ${detail}`.slice(0, 900),
  }));
  const r = await insertNotifications(rows);
  return r.ok ? rows.length : 0;
}

export interface RunJobResult {
  runId: string; dbId?: string;
  status: JobStatus; health: JobHealth; reasons: string[];
  outcome: JobOutcome; httpStatus: number; retried: boolean;
}

export async function runAutomationJob(
  jobName: string,
  opts: { trigger: 'cron' | 'manual' | 'retry' | 'system'; startedBy?: string; retries?: number; notify?: boolean },
  fn: (svc: any) => Promise<JobOutcome>,
): Promise<RunJobResult> {
  const svc = createServiceRoleClient();
  const retries = opts.retries ?? 1;

  const attempt = async (retryOf: string | null): Promise<{ dbId?: string; runId: string; outcome: JobOutcome; started: number }> => {
    const started = Date.now();
    const runId = `${jobName}_${new Date(started).toISOString().replace(/[:.]/g, '-')}${retryOf ? '_r' : ''}`;
    const { data: row } = await (svc.from('automation_runs') as any).insert({
      job_name: jobName, run_id: runId, status: 'running',
      trigger_type: retryOf ? 'retry' : opts.trigger, started_by: opts.startedBy || opts.trigger,
      retry_of_run_id: retryOf,
    }).select('id').maybeSingle();
    let outcome: JobOutcome;
    try {
      outcome = await fn(svc);
    } catch (e: any) {
      outcome = { errorCode: 'EXCEPTION', errorMessage: e?.message || String(e) };
    }
    return { dbId: (row as any)?.id, runId, outcome, started };
  };

  const finalize = async (dbId: string | undefined, started: number, outcome: JobOutcome, v: { status: JobStatus; health: JobHealth; reasons: string[] }) => {
    if (!dbId) return;
    const { error } = await (svc.from('automation_runs') as any).update({
      finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
      status: v.status, health_status: v.health,
      rows_read: outcome.rowsRead ?? null, rows_written: outcome.rowsWritten ?? null,
      rows_updated: outcome.rowsUpdated ?? null, rows_deleted: outcome.rowsDeleted ?? null,
      artifacts_created: outcome.artifacts ?? null, notifications_created: outcome.notificationsCreated ?? null,
      eligible_items: outcome.eligible ?? null, processed_items: outcome.processed ?? null,
      failed_items: outcome.failedItems ?? null, skipped_items: outcome.skippedItems ?? null,
      error_code: outcome.errorCode ?? null, error_message: (outcome.errorMessage || v.reasons.join('; ') || null)?.slice(0, 500) ?? null,
      metadata: { ...(outcome.metadata || {}), steps: outcome.steps || [], reasons: v.reasons },
    }).eq('id', dbId).select('id');
    if (error) console.error(`[runAutomationJob:${jobName}] 台账收尾失败:`, error.message);
  };

  // 第一次
  let a = await attempt(null);
  let verdict = computeJobHealth(a.outcome);
  await finalize(a.dbId, a.started, a.outcome, verdict);
  let retried = false;

  // 失败 → 自动重试一次(job 写路径须幂等)
  if (verdict.status === 'failed' && retries > 0) {
    retried = true;
    console.warn(`[runAutomationJob:${jobName}] 首次失败,重试一次:${verdict.reasons[0]}`);
    const b = await attempt(a.runId);
    const v2 = computeJobHealth(b.outcome);
    await finalize(b.dbId, b.started, b.outcome, v2);
    a = b; verdict = v2;
  }

  if (opts.notify !== false && verdict.health !== 'healthy') {
    const fp = a.outcome.errorCode || (verdict.status === 'failed' ? 'zero-output' : 'degraded');
    const prefix = retried && verdict.status === 'failed' ? '连续 2 次失败。' : '';
    await notifyAutomationHealth(svc, jobName, verdict.health, fp, prefix + verdict.reasons.join('; '));
  }

  console.log(`[runAutomationJob:${jobName}] ${verdict.status}/${verdict.health}${retried ? '(已重试)' : ''}: ${verdict.reasons.join('; ') || 'ok'}`);
  return {
    runId: a.runId, dbId: a.dbId, status: verdict.status, health: verdict.health,
    reasons: verdict.reasons, outcome: a.outcome, retried,
    httpStatus: verdict.status === 'failed' ? 500 : 200,
  };
}
