/**
 * Automation Health Watchdog —— R1-B(2026-08-08)。
 *
 * 不依赖任何人打开页面,每晚核对四个关键自动化的**业务产出**:
 * 沉默超时(该跑没跑)、跑了但零产出(该干没干)都要被抓出来。
 * Watchdog 自己也写 automation_runs —— 不允许"监控自动化的自动化
 * 自己坏了没人知道":它挂在 nightly-maintenance 里,而 nightly 自身
 * 由 system_health_reports + Vercel cron 面板双重可见(见 known risks)。
 *
 * 规则是数据,不是散落的 if —— 加一个受监控 job 只加一行。
 */

import { notifyAutomationHealth, type JobHealth } from './run-job';

export interface WatchRule {
  job: string;
  /** 超过这么多小时没有一次「达标运行」= 沉默告警 */
  maxSilenceHours: number;
  /** 达标 = 这些 status 之一 */
  okStatuses: string[];
  /** 产出规则:对最近一次终态运行做业务断言,返回 null=通过,否则违规原因 */
  outputRule?: (run: any) => string | null;
  severity: 'warning' | 'critical';
  owner: string;
}

export const WATCH_RULES: WatchRule[] = [
  {
    job: 'backup', maxSilenceHours: 26, okStatuses: ['success'], severity: 'critical', owner: 'admin',
    outputRule: (r) => (r.artifacts_created ?? 0) >= 1 ? null : `最近一次成功运行 artifacts_created=${r.artifacts_created ?? 0}(应≥1)`,
  },
  {
    job: 'daily', maxSilenceHours: 26, okStatuses: ['success', 'degraded'], severity: 'critical', owner: 'admin',
    outputRule: (r) => {
      const steps: any[] = r.metadata?.steps || [];
      const sz = steps.find((s) => (s.eligible ?? 0) > 0 && (s.processed ?? s.written ?? 0) === 0);
      return sz ? `步骤 ${sz.step} silent-zero(eligible=${sz.eligible},产出 0)` : null;
    },
  },
  {
    job: 'order-audit', maxSilenceHours: 26, okStatuses: ['success', 'degraded'], severity: 'warning', owner: 'admin',
    outputRule: (r) => {
      const m = r.metadata || {};
      if ((m.audit_hits ?? 0) > 0 && (m.notifications_created ?? 0) === 0 && !m.dedupe_hit) {
        return `audit_hits=${m.audit_hits} 但 notifications_created=0`;
      }
      return null;
    },
  },
  {
    job: 'daily-briefing', maxSilenceHours: 26, okStatuses: ['success', 'degraded'], severity: 'warning', owner: 'admin',
    outputRule: (r) => (r.eligible_items ?? 0) > 0 && (r.processed_items ?? 0) === 0
      ? `eligible=${r.eligible_items} 但 generated=0`
      : null,
  },
];

export interface WatchFinding { job: string; severity: JobHealth; reason: string }

/** 纯判定(可测):给定各 job 最近运行,产出违规清单 */
export function evaluateWatchRules(
  rules: WatchRule[],
  latestRuns: Map<string, { lastOk: any | null; lastAny: any | null }>,
  now: Date = new Date(),
): WatchFinding[] {
  const findings: WatchFinding[] = [];
  for (const rule of rules) {
    const entry = latestRuns.get(rule.job) || { lastOk: null, lastAny: null };
    const sev: JobHealth = rule.severity === 'critical' ? 'critical' : 'warning';

    if (!entry.lastOk) {
      findings.push({ job: rule.job, severity: 'critical', reason: `从未有过达标运行(${rule.okStatuses.join('/')})` });
      continue;
    }
    const ageH = (now.getTime() - new Date(entry.lastOk.started_at).getTime()) / 3600_000;
    if (ageH > rule.maxSilenceHours) {
      findings.push({ job: rule.job, severity: 'critical', reason: `已 ${Math.floor(ageH)} 小时无达标运行(上限 ${rule.maxSilenceHours}h)` });
      continue;
    }
    if (rule.outputRule) {
      const v = rule.outputRule(entry.lastOk);
      if (v) findings.push({ job: rule.job, severity: sev, reason: v });
    }
    // 连续 2 次失败也要抓(即便中间夹着一次旧的达标运行不满足 silence)
    if (entry.lastAny?.status === 'failed' && entry.lastAny?.retry_of_run_id) {
      findings.push({ job: rule.job, severity: 'critical', reason: '最近一次运行重试后仍失败(连续 2 次)' });
    }
  }
  return findings;
}

/** 跑 watchdog:查台账 → 判规则 → 告警(带去重) → 自己也记一行台账 */
export async function runAutomationWatchdog(svc: any): Promise<{ findings: WatchFinding[]; checked: number }> {
  const startedAt = new Date();
  const { data: wdRow } = await (svc.from('automation_runs') as any).insert({
    job_name: 'watchdog', run_id: `watchdog_${startedAt.toISOString().replace(/[:.]/g, '-')}`,
    status: 'running', trigger_type: 'system', started_by: 'nightly-maintenance',
  }).select('id').maybeSingle();

  const latest = new Map<string, { lastOk: any | null; lastAny: any | null }>();
  for (const rule of WATCH_RULES) {
    const { data: ok } = await (svc.from('automation_runs') as any)
      .select('started_at, status, artifacts_created, eligible_items, processed_items, retry_of_run_id, metadata')
      .eq('job_name', rule.job).in('status', rule.okStatuses)
      .order('started_at', { ascending: false }).limit(1);
    const { data: any_ } = await (svc.from('automation_runs') as any)
      .select('started_at, status, retry_of_run_id')
      .eq('job_name', rule.job).neq('status', 'running')
      .order('started_at', { ascending: false }).limit(1);
    latest.set(rule.job, { lastOk: (ok as any[])?.[0] || null, lastAny: (any_ as any[])?.[0] || null });
  }

  const findings = evaluateWatchRules(WATCH_RULES, latest);
  let notified = 0;
  for (const f of findings) {
    notified += await notifyAutomationHealth(svc, f.job, f.severity, `watchdog:${f.reason.slice(0, 40)}`, `Watchdog:${f.reason}`, 20);
  }

  if ((wdRow as any)?.id) {
    await (svc.from('automation_runs') as any).update({
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime(),
      status: 'success', health_status: findings.some((f) => f.severity === 'critical') ? 'critical' : findings.length ? 'warning' : 'healthy',
      eligible_items: WATCH_RULES.length, processed_items: WATCH_RULES.length,
      notifications_created: notified,
      metadata: { findings },
    }).eq('id', (wdRow as any).id);
  }
  console.log(`[watchdog] 检查 ${WATCH_RULES.length} 个 job,违规 ${findings.length} 条,告警 ${notified} 条`);
  return { findings, checked: WATCH_RULES.length };
}
