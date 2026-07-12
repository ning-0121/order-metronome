/**
 * 采购行实收(received_qty)单一真相口径(2026-07-12 审计批4)。
 *
 * received_qty = Σ goods_receipts.received_qty(排除 inspection_result='reject' 拒收)
 *                 − Σ 已确认退货/换货量(procurement_return_lines,父单 status∈returned/replaced)
 * 用退货行的精确 qty 相减(而非按 goods_receipts.return_status 整条排除)——退货常是部分,
 * 整条排除会把「收500退200」误算成 received=0 而非 300。返修(rework)货会回来,不减。
 *
 * 为什么统一:此前 recordGoodsReceipt/recordReceiptBatch 各自 `.neq(inspection_result,'reject')` 汇总,
 * 都没减退货(P2-8:退回料仍算已收、料齐误判、幽灵库存);对账页 recordReceipt 覆盖写不写 goods_receipts,
 * 被批次重算抹掉(P2-4:靠 seedCoveringReceipt 补种子行)。
 */
function round3(n: number): number { return Math.round((Number(n) || 0) * 1000) / 1000; }

/** 该行实收汇总(单一真相口径:Σ收货 − Σ已确认退货)。 */
export async function sumLineReceivedQty(client: any, lineItemId: string): Promise<number> {
  const { data: grs } = await (client.from('goods_receipts') as any)
    .select('received_qty, inspection_result').eq('line_item_id', lineItemId);
  const received = ((grs || []) as any[])
    .filter((r) => r.inspection_result !== 'reject')
    .reduce((s, r) => s + (Number(r.received_qty) || 0), 0);

  // 减已确认退货/换货量(两步查:先取本行退货行,再看其父退货单是否已确认)
  let returned = 0;
  try {
    const { data: rls } = await (client.from('procurement_return_lines') as any)
      .select('qty, disposition, return_id').eq('line_item_id', lineItemId);
    const relevant = ((rls || []) as any[]).filter((r) => ['refund', 'replace'].includes(String(r.disposition || '')));
    if (relevant.length) {
      const returnIds = [...new Set(relevant.map((r) => r.return_id).filter(Boolean))];
      const { data: rets } = await (client.from('procurement_returns') as any).select('id, status').in('id', returnIds);
      const confirmed = new Set(((rets || []) as any[]).filter((r) => ['returned', 'replaced'].includes(String(r.status || ''))).map((r) => r.id));
      for (const rl of relevant) if (confirmed.has(rl.return_id)) returned += Number(rl.qty) || 0;
    }
  } catch { /* 退货表/关系缺失:降级不减(退回按 0) */ }

  return round3(received - returned);
}

/**
 * P2-4:若该行 received_qty 是「对账页覆盖写」来的(有 received_qty 但零 goods_receipts 批次),
 * 在后续验收/分批录入前补一条 goods_receipts 种子行,使汇总口径不丢这部分(否则批次重算把它抹成 0)。
 * 幂等:已有批次则不动;received_qty≤0 则不动。种子行不触发库存(覆盖写时已入库)。
 */
export async function seedCoveringReceipt(
  client: any, lineItemId: string, orderId: string, unit: string | null, userId: string | null,
): Promise<void> {
  const { count } = await (client.from('goods_receipts') as any)
    .select('id', { count: 'exact', head: true }).eq('line_item_id', lineItemId);
  if ((count || 0) > 0) return;
  const { data: line } = await (client.from('procurement_line_items') as any)
    .select('received_qty').eq('id', lineItemId).maybeSingle();
  const prior = Number((line as any)?.received_qty) || 0;
  if (prior <= 0) return;
  await (client.from('goods_receipts') as any).insert({
    line_item_id: lineItemId, order_id: orderId, received_qty: prior, received_unit: unit,
    received_by: userId, inspection_result: 'pending', return_status: null,
    defect_notes: '对账页收货迁移(单一真相收敛)',
  });
}
