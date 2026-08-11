/**
 * 统一「财务放货」Business Command —— 一套放货业务真相,两种入口(2026-08-11 CEO 拍板)。
 *
 * 业务语义钉死:
 *   · 财务批准 = 「可以出」(权限)。放货真相 = order_financials.allow_shipment=true。
 *   · 站内审批(approveShipment)与外部财务系统回调(finance-callback)是同一件事的两个入口,
 *     必须产生**完全一致**的业务结果:开闸 + A2 审计 + 写后回读验证。否则永远两套审批真相。
 *   · 出货完成(confirmOrderShipped)是另一件事(事实,不是权限),不在本 Command。
 *
 * 只做「开放货闸」这一件事;调用方各自负责自己那条确认单(shipment_confirmations)的状态流转。
 * service-role 写(两个入口都持 svc);幂等(已开则直接返回 alreadyOpen)。
 */

import { safeCriticalMutation, safeMutation } from '@/lib/db/safe-mutation';
import { writeAuditEvent } from '@/lib/audit/write-audit-event';

export type ReleaseSource = 'internal' | 'external_finance';

export interface ApproveReleaseInput {
  orderId: string;
  /** 站内:审批人 user_id;外部:审批人姓名/标识(仅入审计,不写 updated_by) */
  approvedBy: string;
  source: ReleaseSource;
  externalReference?: string | null;   // 外部财务系统的审批单号/决策人
  reason?: string | null;
}

export interface ApproveReleaseResult {
  ok: boolean;
  status: string;
  error?: string;
  /** A2 审计是否留痕成功;false = 主写已验证但证据缺失(completed_unverified 语义,admin 已告警) */
  auditVerified?: boolean;
  /** 闸本就已开 → 幂等无副作用 */
  alreadyOpen?: boolean;
}

export async function approveShipmentRelease(
  svc: any,
  input: ApproveReleaseInput,
): Promise<ApproveReleaseResult> {
  const { orderId, approvedBy, source, externalReference, reason } = input;
  const now = new Date().toISOString();
  const reasonText = `财务放货(${source === 'internal' ? '站内审批' : '外部财务系统'})`
    + (externalReference ? `·${externalReference}` : '')
    + (reason ? `:${reason}` : '');
  // 站内审批人写 updated_by;外部来源无对应 user_id → null(主体记在审计 payload)
  const updatedBy = source === 'internal' ? approvedBy : null;
  const auditActor = source === 'internal'
    ? { actorType: 'user' as const, actorId: approvedBy }
    : { actorType: 'system' as const, actorId: `external_finance${externalReference ? ':' + externalReference : ''}` };

  const { data: finRow, error: finErr } = await svc.from('order_financials')
    .select('id, allow_shipment').eq('order_id', orderId).maybeSingle();
  if (finErr) return { ok: false, status: 'db_error', error: `读取 order_financials 失败: ${finErr.message}` };

  // 幂等:闸已开,不重复写、不重复审计
  if (finRow?.allow_shipment === true) return { ok: true, status: 'success', alreadyOpen: true, auditVerified: true };

  if (finRow) {
    // 有行 → safeCriticalMutation(before 快照 + 写断言 + 写后回读 allow_shipment=true + A2 审计一体)
    const r = await safeCriticalMutation({
      client: svc, table: 'order_financials', operation: 'update', expectedRows: 1,
      payload: { allow_shipment: true, updated_by: updatedBy, updated_at: now },
      predicate: { id: finRow.id },
      ctx: {
        actor: source === 'internal' ? approvedBy : 'system',
        reason: reasonText, riskLevel: 'money',
        verifyFields: { allow_shipment: true },
        snapshotFields: ['allow_shipment'],
      },
      auditOrderId: orderId,
    });
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    return { ok: true, status: 'success', auditVerified: r.auditVerified };
  }

  // 无行(旧单)→ 先建行置闸(insert 无 id 谓词,safeMutation 断言行数),再单独 A2 审计
  const ins = await safeMutation({
    client: svc, table: 'order_financials', operation: 'insert', expectedRows: 'any',
    payload: { order_id: orderId, allow_shipment: true, updated_by: updatedBy, updated_at: now },
  });
  if (!ins.ok) return { ok: false, status: ins.status, error: ins.error };
  const ar = await writeAuditEvent({
    eventType: 'business_override', level: 'A2', riskLevel: 'money',
    actor: auditActor,
    entity: { entityType: 'order', entityId: orderId, orderId },
    commandName: 'approveShipmentRelease', reason: reasonText,
    beforeState: { allow_shipment: false }, afterState: { allow_shipment: true },
  });
  return { ok: true, status: 'success', auditVerified: ar.ok };
}
