/** 一行收货的对账金额 = 单价×数量 + 附加费(任一为空按 0)。收货记录补价 / 导出 / 客户端共用。 */
export function receiptAmount(r: { unit_price?: number | null; extra_fee?: number | null; received_qty?: number | null }): number {
  const line = (Number(r.unit_price) || 0) * (Number(r.received_qty) || 0);
  return Math.round((line + (Number(r.extra_fee) || 0)) * 100) / 100;
}
