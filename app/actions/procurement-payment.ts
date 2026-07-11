'use server';

/**
 * 采购付款申请(2026-07-11,P2)。对账确认后,采购分批(每周·自定义金额)提交给财务。
 * 一张对账单挂多笔,Σ(未驳回)≤ 净应付。提交即 emit payable.created 给财务建 payable_records;
 * 付款执行/审批/排款归财务;payment.completed(回带 source_ref)→ finance-callback 累加对账 paid_amount。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const WRITE_MSG = '仅采购/采购经理/管理员可提交付款申请';
const num = (v: any) => (v == null || v === '' ? 0 : Number(v) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVE = ['draft', 'submitted', 'approved', 'paid']; // 计入已占用额度(未驳回/未取消)

/** 列出某对账单的付款申请 + 额度汇总(净应付/已申请/剩余/已付)。 */
export async function listPaymentRequests(reconId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('id, net_payable, paid_amount, currency, status').eq('id', reconId).maybeSingle();
  if (!recon) return { error: '对账单不存在' };
  const { data: reqs } = await (supabase.from('procurement_payment_requests') as any)
    .select('*').eq('reconciliation_id', reconId).order('created_at', { ascending: false });
  const requested = ((reqs || []) as any[]).filter((r) => ACTIVE.includes(r.status)).reduce((s, r) => s + num(r.amount), 0);
  const netPayable = num((recon as any).net_payable);
  return { data: {
    requests: reqs || [], net_payable: netPayable, requested: round2(requested),
    remaining: round2(netPayable - requested), paid_amount: num((recon as any).paid_amount),
    currency: (recon as any).currency || 'RMB',
  } };
}

/** 提交一笔付款申请(自定义金额)→ 建本地记录 + emit payable.created 给财务。 */
export async function submitPaymentRequest(reconId: string, amount: any, opts?: { note?: string; week_label?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const amt = round2(num(amount));
  if (amt <= 0) return { error: '付款金额必须大于 0' };

  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('*').eq('id', reconId).maybeSingle();
  if (!recon) return { error: '对账单不存在' };
  if (!['confirmed', 'submitted', 'paid'].includes((recon as any).status)) {
    return { error: '对账未确认,不能提付款申请(请先确认对账)' };
  }
  // 额度:Σ 未驳回申请 + 本笔 ≤ 净应付
  const { data: reqs } = await (supabase.from('procurement_payment_requests') as any)
    .select('amount, status').eq('reconciliation_id', reconId);
  const used = ((reqs || []) as any[]).filter((r) => ACTIVE.includes(r.status)).reduce((s, r) => s + num(r.amount), 0);
  const netPayable = num((recon as any).net_payable);
  if (round2(used + amt) > round2(netPayable) + 0.01) {
    return { error: `超出净应付:已申请 ¥${round2(used)} + 本笔 ¥${amt} > 净应付 ¥${round2(netPayable)}(剩余 ¥${round2(netPayable - used)})` };
  }

  const poId = (recon as any).purchase_order_id;
  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('po_no, order_ids, currency').eq('id', poId).maybeSingle();
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await (supabase.from('procurement_payment_requests') as any).select('id', { count: 'exact', head: true });
  const requestNo = `PR-${dateTag}-${String((count || 0) + 1).padStart(3, '0')}`;

  const { data: pr, error } = await (supabase.from('procurement_payment_requests') as any).insert({
    request_no: requestNo, reconciliation_id: reconId, purchase_order_id: poId,
    supplier_id: (recon as any).supplier_id, supplier_name: (recon as any).supplier_name,
    amount: amt, currency: (recon as any).currency || 'RMB',
    week_label: opts?.week_label || null, note: opts?.note || null,
    status: 'submitted', submitted_by: user.id,
  }).select('id, request_no').single();
  if (error) return { error: friendlyError(error) };

  // 首次提交 → 对账单标已推财务
  if ((recon as any).status === 'confirmed') {
    await (supabase.from('procurement_reconciliations') as any)
      .update({ status: 'submitted', submitted_to_finance_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', reconId);
  }

  // emit payable.created(fire-and-forget;失败落 outbox,不阻断申请)
  try {
    const { emitProcurementPayableToFinance, fetchOrderRefs } = await import('@/lib/integration/finance-sync');
    let orderRefs: unknown[] = [];
    try { orderRefs = (await fetchOrderRefs(((po as any)?.order_ids || []) as string[])) as unknown[]; } catch { /* ignore */ }

    // 对账明细:采购订单数量/单价/金额 + 采购录入的供应商对账数量/金额,给财务核对实际付款(用户 2026-07-11)
    let lines: unknown[] = [];
    try {
      const { data: rl } = await (supabase.from('procurement_reconciliation_lines') as any)
        .select('material_name, size, ordered_qty, received_qty, unit_price, supplier_qty, supplier_amount, net_amount')
        .eq('reconciliation_id', reconId);
      lines = ((rl || []) as any[]).map((l) => {
        const oq = num(l.ordered_qty), up = num(l.unit_price);
        return {
          material_name: l.material_name ?? null,
          specification: l.size ?? null,
          ordered_qty: oq,                                   // 采购订单数量
          unit_price: up,                                    // 采购订单单价
          po_amount: round2(oq * up),                        // 采购订单金额 = 数量×单价
          received_qty: num(l.received_qty),                 // 系统实收
          supplier_qty: l.supplier_qty != null ? num(l.supplier_qty) : null,      // 供应商对账数量(采购录)
          supplier_amount: l.supplier_amount != null ? num(l.supplier_amount) : null, // 供应商对账金额(采购录)
          net_amount: l.net_amount != null ? num(l.net_amount) : null,            // 本行净应付
        };
      });
    } catch { /* 明细取失败不阻断,退回只有总额 */ }

    await emitProcurementPayableToFinance({
      source_ref: (pr as any).id, bill_no: requestNo,
      supplier_name: (recon as any).supplier_name, supplier_id: (recon as any).supplier_id,
      amount: amt, currency: ((recon as any).currency === 'RMB' ? 'CNY' : (recon as any).currency) || 'CNY',
      description: `采购对账付款 ${(po as any)?.po_no || ''} · ${requestNo}`,
      reconciliation_id: reconId, purchase_order_id: poId, po_no: (po as any)?.po_no || null,
      order_refs: orderRefs, due_date: null, lines,
    });
  } catch (e: any) { console.warn('[submitPaymentRequest] emit payable.created 失败(不阻断):', e?.message); }

  if (poId) revalidatePath(`/procurement/po/${poId}`);
  return { ok: true, id: (pr as any).id, request_no: requestNo };
}
