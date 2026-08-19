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

// ── 2026-08-19 P2 决策单 A2:对账面板删除,随宿主移除专属导出 listPaymentRequests / submitPaymentRequest ──
// (按对账单分批周付款的 UI 只存在于该面板,生产 payment_requests 0 行,从未用过;复活翻 git 历史。)
// 保留 submitPurchaseDeposit:PO 详情页「定金/月结」在用,是「待审批中心 · 付款待回执」的活进料口。

/**
 * 申请定金/预付 或 月结货款(2026-07-11 建;2026-07-24 泛化出月结)。货没到、对账还没确认就要先付供应商一笔。
 * 口径:先付一笔、对账时冲抵 —— 挂在 PO 的对账单上(getOrCreateReconciliation 提前建),
 *   但【不受净应付上限约束】(net_payable 此时通常为 0);走同一条付款通道(防重复付款)。
 * 冲抵:本笔计入该对账单的 requested/paid_amount → 货到重算净应付后,尾款申请上限 = 净应付 − 已申请(含本笔),
 *   自动扣掉;超过最终净应付则剩余为负(供应商多收、需退),UI 如实展示。
 * kind:
 *   - 'deposit'(默认):定金/预付,单号 DP-YYYYMMDD-NNN。
 *   - 'monthly':月结货款(不卡收货)—— 采购按整月对账单金额直接提付款,单号 MS-YYYYMMDD-NNN,便于财务识别。
 * 单号与对账付款 PR- 区分;= 财务 bill_no 防重付。
 */
export async function submitPurchaseDeposit(poId: string, amount: any, opts?: { note?: string; kind?: 'deposit' | 'monthly' }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const kind = opts?.kind === 'monthly' ? 'monthly' : 'deposit';
  const KIND_LABEL = kind === 'monthly' ? '月结货款' : '定金/预付';
  const KIND_PREFIX = kind === 'monthly' ? 'MS' : 'DP';

  const amt = round2(num(amount));
  if (amt <= 0) return { error: `${KIND_LABEL}金额必须大于 0` };

  // 注:purchase_orders 无 supplier_name 列(供应商名在行上/靠 suppliers join),不能 select 它,否则整条查询报错→误判"采购单不存在"。
  const { data: po, error: poErr } = await (supabase.from('purchase_orders') as any)
    .select('id, po_no, status, supplier_id, order_ids, currency, suppliers(name)').eq('id', poId).maybeSingle();
  if (poErr) return { error: `读取采购单失败:${poErr.message}` };
  if (!po) return { error: '采购单不存在' };
  // 定金/月结都是对「已下单」的单付款;草稿单还不是真订单,不给付(避免给没成立的单打款)
  if (['draft', 'cancelled'].includes(String((po as any).status || ''))) {
    return { error: `仅【已下单】的采购单可申请${KIND_LABEL}(草稿单请先下单)。` };
  }

  // 取/建对账单(定金挂它,货到对账时自动冲抵)。此时通常 net_payable=0,不做上限校验。
  const rc = await getOrCreateReconciliation(poId);
  if ((rc as any).error) return { error: `建对账单失败:${(rc as any).error}` };
  const recon = (rc as any).data.reconciliation;
  const reconId = recon.id;
  const supplierName = recon.supplier_name || (po as any).suppliers?.name || null;
  const supplierId = recon.supplier_id || (po as any).supplier_id || null;
  const currency = recon.currency || (po as any).currency || 'RMB';

  // 单号 <前缀>-YYYYMMDD-NNN:取当天已有最大序号+1(删记录不复用空缺号)+ 唯一键冲突自增重试
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dpPrefix = `${KIND_PREFIX}-${dateTag}-`;
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
      week_label: null, note: opts?.note ? `${KIND_LABEL}:${opts.note}` : KIND_LABEL,
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
      description: `采购${KIND_LABEL} ${(po as any)?.po_no || ''} · ${requestNo}${opts?.note ? `(${opts.note})` : ''}`,
      reconciliation_id: reconId, purchase_order_id: poId, po_no: (po as any)?.po_no || null,
      order_refs: orderRefs, due_date: null, lines: [],
    });
  } catch (e: any) { console.warn('[submitPurchaseDeposit] emit payable.created 失败(不阻断):', e?.message); }

  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true, id: (pr as any).id, request_no: requestNo };
}
