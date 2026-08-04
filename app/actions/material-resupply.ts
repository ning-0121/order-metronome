'use server';

/**
 * 补料申请(CEO 2026-08-04 定口径)。
 *
 * 链路:**生产部提请 → 带谁的责任 + 上传签字的责任认定书 → 采购审核 → 财务审核 → 方能补料**
 *
 * 【为什么每一步都不能省】
 * 2026-08-02 事故里三件事之一就是「要扣加工厂的费用忘了登记」。
 * 补料是扣款最主要的诱因 —— 料是谁弄坏/弄少的,钱就该谁出。
 * 但责任认定这件事**只能在补料当下做**,事后没人说得清。所以:
 *   · liable_party 必填,不给默认值 —— 财务据它决定建不建扣款,填错=冤枉供应商
 *   · 责任认定书必须签字上传 —— DB CHECK 强制非空,不是 UI 上的软提示
 *   · 采购审(料对不对、数量合不合理)、财务审(钱怎么算、扣不扣)分两道,不合并
 *
 * 财务事件只在**财务审核通过后**才发 —— 前面几步都还可能被打回,
 * 提前发会让财务建一堆最后没发生的待扣款。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { revalidatePath } from 'next/cache';

export interface ResupplyRow {
  id: string;
  order_id: string;
  material_name: string;
  specification: string | null;
  quantity: number | null;
  unit: string | null;
  reason: string;
  liable_party: 'factory' | 'supplier' | 'customer' | 'qimo' | 'unknown';
  liable_note: string | null;
  evidence_paths: string[];
  status: 'pending_procurement' | 'pending_finance' | 'approved' | 'rejected' | 'cancelled';
  requested_by_name: string | null;
  requested_at: string;
  procurement_reviewed_by_name: string | null;
  procurement_reviewed_at: string | null;
  procurement_note: string | null;
  finance_reviewed_by_name: string | null;
  finance_reviewed_at: string | null;
  finance_note: string | null;
  reject_reason: string | null;
}

/** 责任方中文名 —— UI 与推给财务的 reason 共用,免得两处各写一套 */
export async function liablePartyLabel(v: string): Promise<string> {
  return ({
    factory: '工厂责任', supplier: '供应商责任', customer: '客户责任',
    qimo: '我方责任', unknown: '待定',
  } as Record<string, string>)[v] || v;
}

async function me(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await (supabase.from('profiles') as any)
    .select('name, email, role, roles').eq('user_id', user.id).single();
  return { id: user.id, name: (p as any)?.name || user.email?.split('@')[0] || '', email: user.email };
}

export async function listResupplyRequests(orderId: string): Promise<{ data?: ResupplyRow[]; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('material_resupply_requests') as any)
    .select('*').eq('order_id', orderId).order('requested_at', { ascending: false });
  if (error) return { error: error.message };
  return { data: (data || []) as ResupplyRow[] };
}

/**
 * 生产部提请补料。
 * 门禁:生产线(production / production_manager / qc)+ admin。
 * ⚠️ 业务/理单不在其中 —— CEO 定的是「由生产部提请」,谁发现谁提请会让责任认定失焦。
 */
export async function submitResupplyRequest(input: {
  orderId: string;
  materialName: string;
  specification?: string | null;
  quantity?: number | null;
  unit?: string | null;
  reason: string;
  liableParty: ResupplyRow['liable_party'];
  liableNote?: string | null;
  evidencePaths: string[];
}): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const u = await me(supabase);
  if (!u) return { error: '请先登录' };
  {
    const err = await requireRoleGroup(supabase, u.id, 'CAN_REQUEST_RESUPPLY',
      '补料由生产部提请(生产/生产主管/QC/管理员)');
    if (err) return { error: err };
  }

  if (!input.materialName?.trim()) return { error: '请填写要补的物料名称' };
  if (!input.reason?.trim()) return { error: '请填写补料原因' };
  if (!input.liableParty) return { error: '必须选择责任方 —— 财务据此决定是否向供应商扣款' };
  // 凭证是这条链的立身之本:DB 上有 CHECK,这里再拦一道给出人话
  if (!Array.isArray(input.evidencePaths) || input.evidencePaths.length === 0) {
    return { error: '必须上传**签字的责任认定书**才能提交补料申请 —— 责任认定只能在当下做,事后说不清。' };
  }

  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('material_resupply_requests') as any).insert({
    order_id: input.orderId,
    material_name: input.materialName.trim(),
    specification: input.specification?.trim() || null,
    quantity: input.quantity ?? null,
    unit: input.unit?.trim() || null,
    reason: input.reason.trim(),
    liable_party: input.liableParty,
    liable_note: input.liableNote?.trim() || null,
    evidence_paths: input.evidencePaths,
    status: 'pending_procurement',
    requested_by: u.id,
    requested_by_name: u.name,
  }).select('id').maybeSingle();
  if (error) return { error: error.message };

  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(svc, ['procurement', 'procurement_manager'], {
      type: 'material_resupply', title: `🧵 补料申请待采购审核:${input.materialName}`,
      message: `${u.name} 提请补料「${input.materialName}」,责任方:${await liablePartyLabel(input.liableParty)}。请审核。`,
    });
  } catch { /* 通知失败不阻断 */ }

  revalidatePath(`/orders/${input.orderId}`);
  return { id: (data as any)?.id };
}

/** 采购审核。通过 → 转财务审核;不通过 → rejected。 */
export async function procurementReviewResupply(
  id: string, decision: 'approve' | 'reject', note?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const u = await me(supabase);
  if (!u) return { error: '请先登录' };
  {
    const err = await requireRoleGroup(supabase, u.id, 'CAN_EDIT_PROCUREMENT_EXEC', '仅采购/采购经理/管理员可做采购审核');
    if (err) return { error: err };
  }
  if (decision === 'reject' && !note?.trim()) return { error: '驳回必须写明原因' };

  const svc = createServiceRoleClient();
  // 状态闸:只有 pending_procurement 能被采购审(防重复点/防越级)
  const { data: gate, error } = await (svc.from('material_resupply_requests') as any).update({
    status: decision === 'approve' ? 'pending_finance' : 'rejected',
    procurement_reviewed_by: u.id, procurement_reviewed_by_name: u.name,
    procurement_reviewed_at: new Date().toISOString(),
    procurement_note: note?.trim() || null,
    ...(decision === 'reject' ? { reject_reason: `[采购] ${note?.trim()}` } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'pending_procurement').select('id, order_id, material_name').maybeSingle();
  if (error) return { error: error.message };
  if (!gate) return { error: '该申请不在「待采购审核」状态,可能已被处理' };

  if (decision === 'approve') {
    try {
      const { notifyUsersByRole } = await import('@/lib/utils/notifications');
      await notifyUsersByRole(svc, ['finance'], {
        type: 'material_resupply', title: `💰 补料申请待财务审核:${(gate as any).material_name}`,
        message: `采购(${u.name})已通过,请财务审核补料费用与责任归属。`,
      });
    } catch { /* 通知失败不阻断 */ }
  }
  revalidatePath(`/orders/${(gate as any).order_id}`);
  return { ok: true };
}

/**
 * 财务审核 —— 最后一道。通过后才算「可以补料」,并在此刻推 material.resupplied 给财务系统。
 *
 * 为什么事件在这里发而不是提请时:前两步都还可能被打回,提前发会让财务建一堆
 * 最后没发生的待扣款,反而制造噪音 —— 与「让财务先于人知道」不冲突,
 * 因为责任认定在提请时就已经落定,财务审的是钱不是责任。
 */
export async function financeReviewResupply(
  id: string, decision: 'approve' | 'reject', note?: string, deductionAmount?: number | null,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const u = await me(supabase);
  if (!u) return { error: '请先登录' };
  {
    const err = await requireRoleGroup(supabase, u.id, 'CAN_SEE_FINANCIALS', '仅财务/管理员可做财务审核');
    if (err) return { error: err };
  }
  if (decision === 'reject' && !note?.trim()) return { error: '驳回必须写明原因' };

  const svc = createServiceRoleClient();
  const { data: gate, error } = await (svc.from('material_resupply_requests') as any).update({
    status: decision === 'approve' ? 'approved' : 'rejected',
    finance_reviewed_by: u.id, finance_reviewed_by_name: u.name,
    finance_reviewed_at: new Date().toISOString(),
    finance_note: note?.trim() || null,
    ...(decision === 'reject' ? { reject_reason: `[财务] ${note?.trim()}` } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'pending_finance').select('*').maybeSingle();
  if (error) return { error: error.message };
  if (!gate) return { error: '该申请不在「待财务审核」状态,可能已被处理' };

  if (decision === 'approve') {
    // 推财务系统建待扣款。fire-and-forget:补料审批本身不能因为财务系统不通而失败。
    void (async () => {
      try {
        const r: any = gate;
        const { data: o } = await (svc.from('orders') as any)
          .select('order_no, internal_order_no, factory_name, factory_id').eq('id', r.order_id).maybeSingle();
        const { emitMaterialResupplied } = await import('@/lib/integration/supplier-deduction');
        await emitMaterialResupplied({
          eventRef: `MRR-${r.id}`,
          supplierName: (o as any)?.factory_name ?? null,
          supplierId: (o as any)?.factory_id ?? null,
          orderId: r.order_id,
          orderNo: (o as any)?.order_no ?? null,
          internalOrderNo: (o as any)?.internal_order_no ?? null,
          // 责任方原样透传 —— 客户改单/我方责任时财务侧不建扣款(返回 ignored),这是设计
          liableParty: r.liable_party,
          amount: deductionAmount ?? null,
          reason: `补料:${r.material_name}(${await liablePartyLabel(r.liable_party)})${r.reason ? ' — ' + r.reason : ''}`,
          detail: {
            resupply_request_id: r.id,
            specification: r.specification, quantity: r.quantity, unit: r.unit,
            liable_note: r.liable_note,
            evidence_count: Array.isArray(r.evidence_paths) ? r.evidence_paths.length : 0,
            procurement_reviewer: r.procurement_reviewed_by_name,
            finance_reviewer: u.name,
          },
        });
      } catch (e: any) { console.error('[Resupply] material.resupplied 推送失败(不阻断):', e?.message); }
    })();
  }
  revalidatePath(`/orders/${(gate as any).order_id}`);
  return { ok: true };
}
