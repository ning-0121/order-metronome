/**
 * shipment_batches 最小 repo(2026-08-20):业务层不裸 .from()(数据访问分层门禁)。
 * 目前只承载 updateShipmentBatch 鉴权/同步所需的最小读取;后续批次读写请继续收口到这里。
 */
export async function getBatchRef(
  client: any,
  batchId: string,
): Promise<{ order_id: string | null; status: string | null } | null> {
  const { data } = await (client.from('shipment_batches') as any)
    .select('order_id, status').eq('id', batchId).maybeSingle();
  if (!data) return null;
  return { order_id: (data as any).order_id ?? null, status: (data as any).status ?? null };
}
