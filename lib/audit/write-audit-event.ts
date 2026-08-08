/**
 * 统一审计写入层 —— R1-D Evidence & Audit Integrity(2026-08-08)。
 *
 * EVERY CRITICAL ACTION MUST BE PROVABLE.
 * NO AUDIT ≠ NO PROBLEM. AUDIT FAILURE MUST NEVER BE SILENT.
 *
 * 【为什么】Audit Map 实锤:43 处裸插审计表;order_logs 的 INSERT RLS=仅订单创建人
 * (财务放货/免验/经理操作的审计全被静默拒收,生产 0 条);actor_id/actor_user_id
 * 两套语义并存;96 条审计丢失事故的写法仍是主流。
 *
 * 【方案】不建新表:按 entity 路由现有表(milestone→milestone_logs,order→order_logs),
 * 统一信封进 payload;**一律 service-role 写**(审计不该被业务 RLS 挡)+ 行数断言。
 * 业务代码禁止再直接裸插核心审计表(静态闸 lint:audit 盯防)。
 *
 * 【Criticality】审计失败不一刀切:
 *   A0 best-effort  普通内部事件。失败:业务可成功,console + 返回 degraded。
 *   A1 required     重要运营动作。失败:返回 audit_failed,调用方不得显示完全成功。
 *   A2 mandatory    钱/发货/审批/客户承诺/不可逆。失败:Business Command 不得算
 *                   verified complete —— 调用方必须转 completed_unverified 语义,
 *                   本层自动告警 admin。禁止 silent success。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';

export type ActorType = 'user' | 'agent' | 'system' | 'cron';
export type AuditLevel = 'A0' | 'A1' | 'A2';

export interface AuditEventInput {
  eventType: string;                       // 'mark_done' / 'critical_mutation:orders' / 'business_override' …
  actor: {
    actorType: ActorType;
    actorId: string;                       // user_id / agent 名 / 'system' / job 名
    /** Agent/系统代表谁行动 —— Executive OS 关键字段:"Linda 根据 Alex 的决定执行" */
    onBehalfOfUserId?: string | null;
  };
  entity: { entityType: 'order' | 'milestone'; entityId: string | null; orderId?: string | null };
  commandName?: string;                    // Business Command 函数名
  reason?: string;
  source?: { sourceType?: string; sourceIds?: string[] };
  beforeState?: Record<string, any> | null;
  afterState?: Record<string, any> | null;
  decisionId?: string | null;              // 审批/申请 id —— 反查链的锚
  approvalId?: string | null;
  taskId?: string | null;
  executionId?: string | null;
  automationRunId?: string | null;
  riskLevel?: 'money' | 'delivery' | 'permission' | 'info';
  level: AuditLevel;
  note?: string;
  fromStatus?: string; toStatus?: string;
  metadata?: Record<string, any>;
}

export interface AuditResult {
  ok: boolean;
  status: 'written' | 'audit_failed';
  level: AuditLevel;
  error?: string;
  /** A2 失败时 true:调用方必须把业务结果降级为 completed_unverified,不得宣称完全成功 */
  mandatoryFailure?: boolean;
}

/** 统一信封 —— 所有表共用同一审计语言(人/AI/Agent/cron 一致) */
function envelope(e: AuditEventInput) {
  return {
    v: 1,
    actor: { type: e.actor.actorType, id: e.actor.actorId, on_behalf_of: e.actor.onBehalfOfUserId ?? null },
    command: e.commandName ?? null,
    reason: e.reason ?? null,
    source: e.source ?? null,
    before: e.beforeState ?? null,
    after: e.afterState ?? null,
    decision_id: e.decisionId ?? null,
    approval_id: e.approvalId ?? null,
    task_id: e.taskId ?? null,
    execution_id: e.executionId ?? null,
    automation_run_id: e.automationRunId ?? null,
    risk: e.riskLevel ?? null,
    level: e.level,
    ...(e.metadata ? { meta: e.metadata } : {}),
  };
}

export async function writeAuditEvent(e: AuditEventInput): Promise<AuditResult> {
  let error: string | undefined;
  try {
    const svc = createServiceRoleClient();
    // actor_user_id 兼容列:只有真人才写(agent/system/cron 的主体在 payload.actor;
    // on_behalf_of 有值时写代表的人,保证老查询"谁干的"不至于空)
    const actorUserId = e.actor.actorType === 'user'
      ? e.actor.actorId
      : (e.actor.onBehalfOfUserId ?? null);

    const row = e.entity.entityType === 'milestone'
      ? {
          table: 'milestone_logs',
          data: {
            milestone_id: e.entity.entityId ?? null,
            order_id: e.entity.orderId ?? null,
            actor_user_id: actorUserId,
            action: e.eventType,
            note: (e.note ?? e.reason ?? '').slice(0, 500) || null,
            from_status: e.fromStatus ?? null,
            to_status: e.toStatus ?? null,
            payload: envelope(e),
          },
        }
      : {
          table: 'order_logs',
          data: {
            order_id: e.entity.orderId ?? e.entity.entityId!,
            actor_user_id: actorUserId,
            action: e.eventType,
            note: (e.note ?? e.reason ?? '').slice(0, 500) || null,
            from_status: e.fromStatus ?? null,
            to_status: e.toStatus ?? null,
            payload: envelope(e),
          },
        };

    const { data, error: insErr } = await (svc.from(row.table) as any).insert(row.data).select('id');
    if (insErr) error = `${insErr.code || ''} ${insErr.message}`.trim();       // 含 schema drift(42703 等),绝不静默
    else if (!data || data.length !== 1) error = `审计写入 0 行(表 ${row.table})`;
  } catch (ex: any) {
    error = ex?.message || String(ex);
  }

  if (!error) return { ok: true, status: 'written', level: e.level };

  // ── 失败分级处置 —— 永不静默 ──
  console.error(`[writeAuditEvent:${e.level}] ${e.eventType} 审计失败: ${error}`);
  if (e.level === 'A2') {
    // 强制审计:告警 admin(尽力,失败也要留 console 痕),并要求调用方降级
    try {
      const svc = createServiceRoleClient();
      const { data: admins } = await (svc.from('profiles') as any)
        .select('user_id').or('role.eq.admin,roles.cs.{admin}');
      const { insertNotifications } = await import('@/lib/utils/notifications');
      await insertNotifications(((admins || []) as any[]).map((a) => ({
        user_id: a.user_id, type: 'audit_failure',
        title: `🔴 强制审计写入失败:${e.eventType}`,
        message: `[A2] ${e.commandName || ''} 对 ${e.entity.entityType}#${e.entity.entityId} 的审计留痕失败(${error?.slice(0, 150)})。业务结果已按 completed_unverified 处理,请人工核实。`,
      })));
    } catch (nx: any) { console.error('[writeAuditEvent] A2 告警也失败了:', nx?.message); }
    return { ok: false, status: 'audit_failed', level: e.level, error, mandatoryFailure: true };
  }
  return { ok: false, status: 'audit_failed', level: e.level, error, mandatoryFailure: false };
}
