'use server';

/**
 * 采购对账 + 退货/返修(2026-07-11,P1)。
 * 架构:采购对账(收货实况/退货/折扣→净应付)归节拍器;付款/排款归财务(P2 才推)。
 * 粒度:一 PO 一张对账单。净应付 = Σ(收货−退货)×价 − 逐行折扣 − 整单折扣。
 * 权限:采购/采购经理/管理员可读写(RLS + action 层双门禁)。
 */

import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/utils/db-error';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { sumGrossReceived } from '@/lib/procurement/receivedQty';
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

// ── 2026-08-19 P2 决策单 A2:面板 ProcurementReconciliationPanel 删除,随宿主移除 6 个专属导出 ──
// (saveReconciliationLine / saveReconciliationHeader / confirmReconciliation / listPoReceiptBatches /
//  createProcurementReturn / confirmProcurementReturn —— 生产对账/退货表均 0 行,从未用过;复活翻 git 历史)
// 本文件仅保留 getOrCreateReconciliation:定金/月结付款申请(procurement-payment.ts)建对账单挂靠用。
