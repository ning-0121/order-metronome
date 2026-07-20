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
import { getOrCreateReconciliation } from './procurement-reconciliation';

const WRITE_MSG = '仅采购/采购经理/管理员可提交付款申请';
const num = (v: any) => (v == null || v === '' ? 0 : Number(v) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVE = ['draft', 'submitted', 'approved', 'paid']; // 计入已占用额度(未驳回/未取消)

/** 列出某对账单的付款申请 + 额度汇总(净应付/已申请/剩余/已付)。 */
export async function listPaymentRequests(reconId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_SEE_PROCUREMENT_FLOOR', '无权查看采购付款金额'); if (err) return { error: err }; }
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
  // 生成 request_no PR-YYYYMMDD-NNN(3 位)。
  // 修(2026-07-11):原按「全表记录数+1」算序号——删付款申请会让计数缩水→下一号撞现存号
  //   (同 purchase_orders_po_no_key 一类隐患)。改为【取当天已存在最大序号+1】(删单不复用空缺号),
  //   并对唯一键冲突自增重试(防并发建单撞号)。
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prPrefix = `PR-${dateTag}-`;
  const nextRequestNo = async (bump: number): Promise<string> => {
    const { data: existing } = await (supabase.from('procurement_payment_requests') as any)
      .select('request_no').like('request_no', `${prPrefix}%`);
    let maxN = 0;
    for (const r of (existing || []) as any[]) {
      const m = /-(\d+)$/.exec(String(r.request_no || ''));
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `${prPrefix}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };

  let pr: any = null; let error: any = null; let requestNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    requestNo = await nextRequestNo(attempt);   // 每次重试重算最大值 + attempt 偏移,跳过并发被抢占的号
    const res = await (supabase.from('procurement_payment_requests') as any).insert({
      request_no: requestNo, reconciliation_id: reconId, purchase_order_id: poId,
      supplier_id: (recon as any).supplier_id, supplier_name: (recon as any).supplier_name,
      amount: amt, currency: (recon as any).currency || 'RMB',
      week_label: opts?.week_label || null, note: opts?.note || null,
      status: 'submitted', submitted_by: user.id,
    }).select('id, request_no').single();
    pr = res.data; error = res.error;
    if (!error) break;
    // 仅对「单号唯一键冲突」重试;其他错误(权限/外键/列缺失)立即抛出,不空转
    if (!/request_no_key|duplicate key/i.test(error.message || '')) break;
  }
  if (error) return { error: friendlyError(error) };

  // P3-1 审计:上面的额度校验与 insert 非原子 → 并发可双双过 cap 后同时插入超额。
  //   insert 后复核:活跃申请总额若已超净应付,说明本笔造成超额 → 作废本笔并报错。
  //   delete 让并发自解(先复核者撤销自己,另一笔复核时就落回预算内存活);同时超则都撤、用户重试。
  {
    const { data: after } = await (supabase.from('procurement_payment_requests') as any)
      .select('amount, status').eq('reconciliation_id', reconId);
    const activeTotal = ((after || []) as any[]).filter((r) => ACTIVE.includes(r.status)).reduce((s, r) => s + num(r.amount), 0);
    if (round2(activeTotal) > round2(netPayable) + 0.01) {
      await (supabase.from('procurement_payment_requests') as any).delete().eq('id', (pr as any).id);
      return { error: `并发提交导致超出净应付(¥${round2(netPayable)}),本笔已撤销,请刷新后重试。` };
    }
  }

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
    try { orderRefs = (await fetchOrderRefs(supabase, ((po as any)?.order_ids || []) as string[])) as unknown[]; } catch { /* ignore */ }

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

/**
 * 申请定金/预付(2026-07-11)。货没到、对账还没确认就要先付供应商一笔(定金/预付款)。
 * 口径:先付一笔、对账时冲抵 —— 挂在 PO 的对账单上(getOrCreateReconciliation 提前建),
 *   但【不受净应付上限约束】(net_payable 此时通常为 0);走同一条付款通道(防重复付款)。
 * 冲抵:本笔计入该对账单的 requested/paid_amount → 货到重算净应付后,尾款申请上限 = 净应付 − 已申请(含定金),
 *   自动扣掉定金;定金超过最终净应付则剩余为负(供应商多收、需退),UI 如实展示。
 * 单号 DP-YYYYMMDD-NNN(与对账付款 PR- 区分,便于财务识别定金);= 财务 bill_no 防重付。
 */
export async function submitPurchaseDeposit(poId: string, amount: any, opts?: { note?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const amt = round2(num(amount));
  if (amt <= 0) return { error: '定金金额必须大于 0' };

  // 注:purchase_orders 无 supplier_name 列(供应商名在行上/靠 suppliers join),不能 select 它,否则整条查询报错→误判"采购单不存在"。
  const { data: po, error: poErr } = await (supabase.from('purchase_orders') as any)
    .select('id, po_no, status, supplier_id, order_ids, currency, suppliers(name)').eq('id', poId).maybeSingle();
  if (poErr) return { error: `读取采购单失败:${poErr.message}` };
  if (!po) return { error: '采购单不存在' };
  // 定金是对「已下单」的单预付;草稿单还不是真订单,不给付定金(避免给没成立的单打款)
  if (['draft', 'cancelled'].includes(String((po as any).status || ''))) {
    return { error: '仅【已下单】的采购单可申请定金/预付(草稿单请先下单)。' };
  }

  // 取/建对账单(定金挂它,货到对账时自动冲抵)。此时通常 net_payable=0,不做上限校验。
  const rc = await getOrCreateReconciliation(poId);
  if ((rc as any).error) return { error: `建对账单失败:${(rc as any).error}` };
  const recon = (rc as any).data.reconciliation;
  const reconId = recon.id;
  const supplierName = recon.supplier_name || (po as any).suppliers?.name || null;
  const supplierId = recon.supplier_id || (po as any).supplier_id || null;
  const currency = recon.currency || (po as any).currency || 'RMB';

  // 单号 DP-YYYYMMDD-NNN:取当天已有最大序号+1(删记录不复用空缺号)+ 唯一键冲突自增重试
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dpPrefix = `DP-${dateTag}-`;
  const nextNo = async (bump: number): Promise<string> => {
    const { data: existing } = await (supabase.from('procurement_payment_requests') as any)
      .select('request_no').like('request_no', `${dpPrefix}%`);
    let maxN = 0;
    for (const r of (existing || []) as any[]) {
      const m = /-(\d+)$/.exec(String(r.request_no || ''));
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `${dpPrefix}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };

  let pr: any = null; let error: any = null; let requestNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    requestNo = await nextNo(attempt);
    const res = await (supabase.from('procurement_payment_requests') as any).insert({
      request_no: requestNo, reconciliation_id: reconId, purchase_order_id: poId,
      supplier_id: supplierId, supplier_name: supplierName,
      amount: amt, currency,
      week_label: null, note: opts?.note ? `定金/预付:${opts.note}` : '定金/预付',
      status: 'submitted', submitted_by: user.id,
    }).select('id, request_no').single();
    pr = res.data; error = res.error;
    if (!error) break;
    if (!/request_no_key|duplicate key/i.test(error.message || '')) break;
  }
  if (error) return { error: friendlyError(error) };

  // emit payable.created 给财务(同一条付款通道,防重复付款)。定金无逐行明细。
  try {
    const { emitProcurementPayableToFinance, fetchOrderRefs } = await import('@/lib/integration/finance-sync');
    let orderRefs: unknown[] = [];
    try { orderRefs = (await fetchOrderRefs(supabase, ((po as any)?.order_ids || []) as string[])) as unknown[]; } catch { /* ignore */ }
    await emitProcurementPayableToFinance({
      source_ref: (pr as any).id, bill_no: requestNo,
      supplier_name: supplierName, supplier_id: supplierId,
      amount: amt, currency: (currency === 'RMB' ? 'CNY' : currency) || 'CNY',
      description: `采购定金/预付 ${(po as any)?.po_no || ''} · ${requestNo}${opts?.note ? `(${opts.note})` : ''}`,
      reconciliation_id: reconId, purchase_order_id: poId, po_no: (po as any)?.po_no || null,
      order_refs: orderRefs, due_date: null, lines: [],
    });
  } catch (e: any) { console.warn('[submitPurchaseDeposit] emit payable.created 失败(不阻断):', e?.message); }

  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true, id: (pr as any).id, request_no: requestNo };
}
