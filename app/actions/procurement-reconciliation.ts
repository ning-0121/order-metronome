'use server';

/**
 * 采购对账 + 退货/返修(2026-07-11,P1)。
 * 架构:采购对账(收货实况/退货/折扣→净应付)归节拍器;付款/排款归财务(P2 才推)。
 * 粒度:一 PO 一张对账单。净应付 = Σ(收货−退货)×价 − 逐行折扣 − 整单折扣。
 * 权限:采购/采购经理/管理员可读写(RLS + action 层双门禁)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { sumLineReceivedQty, sumGrossReceived } from '@/lib/procurement/receivedQty';
import { isFabricCategory } from '@/lib/services/procurement-execution';

const WRITE_MSG = '仅采购/采购经理/管理员可做采购对账/退货';
const num = (v: any) => (v == null || v === '' ? 0 : Number(v) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 该 PO 的采购执行行(对账明细来源)。 */
async function fetchPoLines(supabase: any, poId: string) {
  const { data } = await (supabase.from('procurement_line_items') as any)
    .select('id, material_name, size, category, ordered_qty, ordered_unit, unit_price, received_qty, line_status, purchase_order_id')
    .eq('purchase_order_id', poId).order('created_at', { ascending: true });
  return (data || []) as any[];
}

/** 重算一张对账单的金额(系统/退货/折扣/净应付),写回头 + 各行 net_amount。 */
async function recompute(supabase: any, reconId: string) {
  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('id, discount_amount').eq('id', reconId).maybeSingle();
  if (!recon) return;
  const { data: lines } = await (supabase.from('procurement_reconciliation_lines') as any)
    .select('id, received_qty, unit_price, return_qty, line_discount').eq('reconciliation_id', reconId);
  let systemAmount = 0, returnAmount = 0, lineDiscountTotal = 0, netFromLines = 0;
  for (const l of (lines || [])) {
    const price = num(l.unit_price), recv = num(l.received_qty), ret = num(l.return_qty), disc = num(l.line_discount);
    const lineNet = round2((recv - ret) * price - disc);
    systemAmount += recv * price;
    returnAmount += ret * price;
    lineDiscountTotal += disc;
    netFromLines += lineNet;
    await (supabase.from('procurement_reconciliation_lines') as any)
      .update({ net_amount: lineNet, updated_at: new Date().toISOString() }).eq('id', l.id);
  }
  const headerDiscount = num((recon as any).discount_amount);
  const netPayable = round2(netFromLines - headerDiscount);
  await (supabase.from('procurement_reconciliations') as any).update({
    system_amount: round2(systemAmount), return_amount: round2(returnAmount),
    net_payable: netPayable, updated_at: new Date().toISOString(),
  }).eq('id', reconId);
}

/**
 * 取/建 PO 的对账单:拉该 PO 采购行 → upsert 对账明细(刷新系统收货字段,保留采购已录的供应商数/折扣)。
 * 已 confirmed/submitted/paid 的对账单不刷新明细(锁定)。
 */
export async function getOrCreateReconciliation(poId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('id, po_no, supplier_id, currency, suppliers(name)').eq('id', poId).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  const supplierName = (po as any).suppliers?.name || null;

  let { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('*').eq('purchase_order_id', poId).maybeSingle();
  if (!recon) {
    const { data: created, error } = await (supabase.from('procurement_reconciliations') as any).insert({
      purchase_order_id: poId, supplier_id: (po as any).supplier_id, supplier_name: supplierName,
      currency: (po as any).currency || 'RMB', status: 'draft', created_by: user.id,
    }).select('*').single();
    if (error) return { error: friendlyError(error) };
    recon = created;
  }
  const locked = ['confirmed', 'submitted', 'paid'].includes((recon as any).status);

  // 明细:确认前刷新系统字段(upsert by line_item_id);已锁定则只读现有明细
  if (!locked) {
    // Phase2 根治重复付款(角色审计):**面料行不进系统PO对账**——面料应付归台账 LG 独占,
    //   避免同批面料在「对账PR」和「台账LG」两条渠道各推一次 payable、财务双付。辅料/加工照常入对账。
    const poLines = (await fetchPoLines(supabase, poId)).filter((pl: any) => !isFabricCategory(pl.category));
    const keepPliIds = new Set(poLines.map((pl: any) => pl.id));
    const { data: existLines } = await (supabase.from('procurement_reconciliation_lines') as any)
      .select('id, line_item_id').eq('reconciliation_id', (recon as any).id);
    // 清掉历史遗留的面料对账行(本次已从 poLines 排除)+ 已不在 PO 的行 —— 否则 recompute 仍把它们计入净应付
    const orphanIds = ((existLines || []) as any[]).filter((l) => !keepPliIds.has(l.line_item_id)).map((l) => l.id);
    if (orphanIds.length) {
      await (supabase.from('procurement_reconciliation_lines') as any).delete().in('id', orphanIds);
    }
    const byPli = new Map<string, string>(((existLines || []) as any[]).map((l) => [l.line_item_id, l.id]));
    for (const pl of poLines) {
      // 角色审计修:对账行 received_qty 用【毛量】(Σ收货非拒收),对账再按 gross − return_qty 算净应付。
      //   之前误用 pl.received_qty(批4改成了净额)→ recompute 的 (净−ret) 双减退货 → 供应商少付。
      const grossRecv = await sumGrossReceived(supabase, pl.id);
      const sys = { material_name: pl.material_name, size: pl.size, ordered_qty: pl.ordered_qty, received_qty: grossRecv, unit_price: pl.unit_price };
      const hit = byPli.get(pl.id);
      if (hit) {
        await (supabase.from('procurement_reconciliation_lines') as any).update({ ...sys, updated_at: new Date().toISOString() }).eq('id', hit);
      } else {
        await (supabase.from('procurement_reconciliation_lines') as any).insert({ reconciliation_id: (recon as any).id, line_item_id: pl.id, ...sys });
      }
    }
    await recompute(supabase, (recon as any).id);
    ({ data: recon } = await (supabase.from('procurement_reconciliations') as any).select('*').eq('id', (recon as any).id).maybeSingle());
  }

  const { data: lines } = await (supabase.from('procurement_reconciliation_lines') as any)
    .select('*').eq('reconciliation_id', (recon as any).id).order('created_at', { ascending: true });
  const { data: returns } = await (supabase.from('procurement_returns') as any)
    .select('*, procurement_return_lines(*)').eq('purchase_order_id', poId).order('created_at', { ascending: false });
  return { data: { reconciliation: recon, lines: lines || [], returns: returns || [], locked, po } };
}

/** 采购录一行:供应商数量/金额、逐行折扣、备注。confirmed 后不许改。 */
export async function saveReconciliationLine(lineId: string, patch: { supplier_qty?: any; supplier_amount?: any; line_discount?: any; note?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: line } = await (supabase.from('procurement_reconciliation_lines') as any)
    .select('id, reconciliation_id').eq('id', lineId).maybeSingle();
  if (!line) return { error: '对账行不存在' };
  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('status, purchase_order_id').eq('id', (line as any).reconciliation_id).maybeSingle();
  if (['confirmed', 'submitted', 'paid'].includes((recon as any)?.status)) return { error: '对账已确认,不能改明细(如需改请撤回确认)' };

  const upd: any = { updated_at: new Date().toISOString() };
  if ('supplier_qty' in patch) upd.supplier_qty = patch.supplier_qty === '' ? null : num(patch.supplier_qty);
  if ('supplier_amount' in patch) upd.supplier_amount = patch.supplier_amount === '' ? null : num(patch.supplier_amount);
  if ('line_discount' in patch) upd.line_discount = num(patch.line_discount);
  if ('note' in patch) upd.note = patch.note || null;
  const { error } = await (supabase.from('procurement_reconciliation_lines') as any).update(upd).eq('id', lineId);
  if (error) return { error: friendlyError(error) };
  await recompute(supabase, (line as any).reconciliation_id);
  if ((recon as any)?.purchase_order_id) revalidatePath(`/procurement/po/${(recon as any).purchase_order_id}`);
  return { ok: true };
}

/** 对账单头:整单折扣/返点、供应商对账单金额、备注。 */
export async function saveReconciliationHeader(reconId: string, patch: { discount_amount?: any; supplier_statement_amount?: any; notes?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('status').eq('id', reconId).maybeSingle();
  if (!recon) return { error: '对账单不存在' };
  if (['confirmed', 'submitted', 'paid'].includes((recon as any).status)) return { error: '对账已确认,不能改' };

  const upd: any = { updated_at: new Date().toISOString() };
  if ('discount_amount' in patch) upd.discount_amount = num(patch.discount_amount);
  if ('supplier_statement_amount' in patch) upd.supplier_statement_amount = patch.supplier_statement_amount === '' ? null : num(patch.supplier_statement_amount);
  if ('notes' in patch) upd.notes = patch.notes || null;
  const { error } = await (supabase.from('procurement_reconciliations') as any).update(upd).eq('id', reconId);
  if (error) return { error: friendlyError(error) };
  await recompute(supabase, reconId);
  return { ok: true };
}

/** 确认对账:锁定净应付(P2 才推财务)。撤回=改回 draft。 */
export async function confirmReconciliation(reconId: string, confirm = true) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('status').eq('id', reconId).maybeSingle();
  if (!recon) return { error: '对账单不存在' };
  if (confirm && (recon as any).status !== 'draft') return { error: '仅草稿态可确认' };
  if (!confirm && (recon as any).status !== 'confirmed') return { error: '仅已确认(未推财务)可撤回' };

  await recompute(supabase, reconId);
  const upd: any = confirm
    ? { status: 'confirmed', confirmed_by: user.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: 'draft', confirmed_by: null, confirmed_at: null, updated_at: new Date().toISOString() };
  const { error } = await (supabase.from('procurement_reconciliations') as any).update(upd).eq('id', reconId);
  if (error) return { error: friendlyError(error) };
  return { ok: true };
}

/** 某 PO 各采购行的收货批次(退货单选货源)。 */
export async function listPoReceiptBatches(poId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const lines = await fetchPoLines(supabase, poId);
  const ids = lines.map((l) => l.id);
  if (ids.length === 0) return { data: [] };
  const { data: batches } = await (supabase.from('goods_receipts') as any)
    .select('id, line_item_id, received_qty, received_at, inspection_result, return_status')
    .in('line_item_id', ids).order('received_at', { ascending: false });
  return { data: batches || [] };
}

/**
 * 建退货/返修单(草稿)。lines: [{line_item_id, goods_receipt_id?, qty, disposition, unit_price?, reason?}]。
 * amount 未给则按 unit_price×qty 或采购行单价算。
 */
export async function createProcurementReturn(poId: string, payload: {
  type: 'return' | 'replace' | 'rework'; reason?: string; notes?: string; attachment_paths?: string[];
  lines: Array<{ line_item_id: string; goods_receipt_id?: string | null; qty: any; disposition?: 'refund' | 'replace' | 'rework'; unit_price?: any; reason?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('id, supplier_id, suppliers(name)').eq('id', poId).maybeSingle();
  if (!po) return { error: '采购单不存在' };

  const poLines = await fetchPoLines(supabase, poId);
  const priceByPli = new Map<string, number>(poLines.map((l) => [l.id, num(l.unit_price)]));
  const clean = (payload.lines || []).map((l) => {
    const qty = num(l.qty);
    const price = l.unit_price != null && l.unit_price !== '' ? num(l.unit_price) : (priceByPli.get(l.line_item_id) || 0);
    return { line_item_id: l.line_item_id, goods_receipt_id: l.goods_receipt_id || null, qty, unit_price: price,
      amount: round2(qty * price), disposition: l.disposition || 'refund', reason: l.reason || null };
  }).filter((l) => l.line_item_id && l.qty > 0);
  if (clean.length === 0) return { error: '请至少录一行退货明细(选采购行 + 数量>0)' };

  const totalQty = clean.reduce((s, l) => s + l.qty, 0);
  const totalAmount = round2(clean.filter((l) => l.disposition === 'refund').reduce((s, l) => s + l.amount, 0));
  // 生成 return_no RT-YYYYMMDD-NNN(3 位)。
  // 修(2026-07-11):原按「全表记录数+1」算序号——删退货单会让计数缩水→下一号撞现存号
  //   (同 purchase_orders_po_no_key 一类隐患)。改为【取当天已存在最大序号+1】(删单不复用空缺号),
  //   并对唯一键冲突自增重试(防并发建单撞号)。
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rtPrefix = `RT-${dateTag}-`;
  const nextReturnNo = async (bump: number): Promise<string> => {
    const { data: existing } = await (supabase.from('procurement_returns') as any)
      .select('return_no').like('return_no', `${rtPrefix}%`);
    let maxN = 0;
    for (const r of (existing || []) as any[]) {
      const m = /-(\d+)$/.exec(String(r.return_no || ''));
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `${rtPrefix}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };

  let ret: any = null; let error: any = null; let returnNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    returnNo = await nextReturnNo(attempt);   // 每次重试重算最大值 + attempt 偏移,跳过并发被抢占的号
    const res = await (supabase.from('procurement_returns') as any).insert({
      return_no: returnNo, purchase_order_id: poId, supplier_id: (po as any).supplier_id,
      supplier_name: (po as any).suppliers?.name || null, type: payload.type || 'return', status: 'draft',
      reason: payload.reason || null, notes: payload.notes || null,
      attachment_paths: Array.isArray(payload.attachment_paths) ? payload.attachment_paths : [],
      total_qty: totalQty, total_amount: totalAmount, created_by: user.id,
    }).select('id').single();
    ret = res.data; error = res.error;
    if (!error) break;
    // 仅对「单号唯一键冲突」重试;其他错误(权限/外键/列缺失)立即抛出,不空转
    if (!/return_no_key|duplicate key/i.test(error.message || '')) break;
  }
  if (error) return { error: friendlyError(error) };

  await (supabase.from('procurement_return_lines') as any).insert(clean.map((l) => ({ return_id: (ret as any).id, ...l })));
  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true, id: (ret as any).id, return_no: returnNo };
}

/**
 * 确认退货/返修单:refund 类 → 回填对账明细 return_qty(冲减净应付)+ 回写 goods_receipts.return_status。
 * 换货/返修不冲应付(货会回来)。退货/换货(货离库)同步重算 received_qty + 冲减库存(P2-8);
 * 退货量不得超已收(P3-3);返修(rework)不冲(货会回来)。
 */
export async function confirmProcurementReturn(returnId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
  if (gate) return { error: gate };

  const { data: ret } = await (supabase.from('procurement_returns') as any)
    .select('id, status, type, purchase_order_id').eq('id', returnId).maybeSingle();
  if (!ret) return { error: '退货单不存在' };
  if ((ret as any).status !== 'draft') return { error: '仅草稿态退货单可确认' };
  const { data: rlines } = await (supabase.from('procurement_return_lines') as any)
    .select('line_item_id, goods_receipt_id, qty, disposition').eq('return_id', returnId);

  // 找该 PO 的对账单(refund 类要回填 return_qty)
  const { data: recon } = await (supabase.from('procurement_reconciliations') as any)
    .select('id, status').eq('purchase_order_id', (ret as any).purchase_order_id).maybeSingle();
  if (recon && ['confirmed', 'submitted', 'paid'].includes((recon as any).status)) {
    return { error: '该 PO 对账已确认,退货请先撤回对账确认再处理' };
  }

  // 本退货单每行的「离库」退货量(refund/replace = 货退回供应商;rework 货会回来,不算离库)
  const outQtyByLine = new Map<string, number>();
  if ((ret as any).type !== 'rework') {
    for (const rl of (rlines || [])) {
      if (!(rl as any).line_item_id) continue;
      outQtyByLine.set((rl as any).line_item_id, (outQtyByLine.get((rl as any).line_item_id) || 0) + num((rl as any).qty));
    }
  }
  // P3-3/P3-1 审计:退货量上限 —— 本次退货不得超「已收净额」(sumLineReceivedQty 已减之前已确认退货)。
  //   无对账单(recon=null)也校验,防 received_qty/库存被打成负数。
  for (const [lid, retQty] of outQtyByLine) {
    const netReceived = await sumLineReceivedQty(supabase, lid);
    if (retQty > netReceived + 0.001) {
      return { error: `退货量超过可退:该料当前已收净额 ${netReceived},本次退 ${retQty} 超出。请核对退货数量。` };
    }
  }

  // 原子认领(防并发/重试双确认 → 双回填 return_qty / 双扣库存):draft→doneStatus 只成功一次,
  //   放在所有 mutation 之前,只有抢到翻转的调用继续。additive 的 adjust 冲减没有 receipt 幂等键兜底,
  //   全靠这层原子性防重(复核残留项)。
  const doneStatus = (ret as any).type === 'replace' ? 'replaced' : (ret as any).type === 'rework' ? 'reworked' : 'returned';
  const { data: claimed, error: claimErr } = await (supabase.from('procurement_returns') as any)
    .update({ status: doneStatus, updated_at: new Date().toISOString() })
    .eq('id', returnId).eq('status', 'draft').select('id');
  if (claimErr) return { error: friendlyError(claimErr) };
  if (!claimed || (claimed as any[]).length === 0) return { error: '该退货单已被确认(请勿重复提交)' };

  for (const rl of (rlines || [])) {
    // refund 退货 → 累加对账行 return_qty
    if (recon && (rl as any).disposition === 'refund' && (rl as any).line_item_id) {
      const { data: rcLine } = await (supabase.from('procurement_reconciliation_lines') as any)
        .select('id, return_qty').eq('reconciliation_id', (recon as any).id).eq('line_item_id', (rl as any).line_item_id).maybeSingle();
      if (rcLine) {
        await (supabase.from('procurement_reconciliation_lines') as any)
          .update({ return_qty: num((rcLine as any).return_qty) + num((rl as any).qty), updated_at: new Date().toISOString() })
          .eq('id', (rcLine as any).id);
      }
    }
    // 回写收货批次退货状态
    if ((rl as any).goods_receipt_id) {
      const rs = (ret as any).type === 'replace' ? 'replaced' : (ret as any).type === 'rework' ? 'pending' : 'returned';
      await (supabase.from('goods_receipts') as any)
        .update({ return_required: true, return_status: rs }).eq('id', (rl as any).goods_receipt_id);
    }
  }
  if (recon) await recompute(supabase, (recon as any).id);

  // (退货单已在上方原子认领为 doneStatus;helper 的 received_qty 重算依赖父单已确认。)
  // P2-8 审计:退货/换货(货已离库)→ 重算实收(helper 已减已确认退货,支持部分退)+ 冲减库存。
  //   ⚠️ 库存冲减走独立 adjust 负流水(recordSupplierReturnDeduction),不复用 recordInventoryReceipt 的
  //   负 delta —— 后者幂等键假设 received 单调递增,退货拉低会撞历史 cumulative 被静默吞掉(审计 P2-1)。
  //   退货单只确认一次(status 已 draft→doneStatus),故按本次退货量一次性冲减,天然防重。
  for (const [lid, retQty] of outQtyByLine) {
    try {
      const newReceived = await sumLineReceivedQty(supabase, lid);   // 父单已确认→已含本次退货
      await (supabase.from('procurement_line_items') as any)
        .update({ received_qty: newReceived, updated_at: new Date().toISOString() }).eq('id', lid);
      const { recordSupplierReturnDeduction } = await import('@/app/actions/inventory');
      await recordSupplierReturnDeduction(lid, retQty, `退货单确认冲减(${returnId.slice(0, 8)})`);
    } catch (e: any) { console.warn('[confirmProcurementReturn] 退货冲减实收/库存失败(不阻断):', e?.message); }
  }

  revalidatePath(`/procurement/po/${(ret as any).purchase_order_id}`);
  return { ok: true };
}
