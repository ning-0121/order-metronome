// ============================================================
// Shipment Confirmations Repository —— 出货确认单的数据访问收口
//
// 2026-08-17 建:`app/actions/confirm-shipped.ts` 里有 4 处裸 `.from()`
// (shipment_confirmations ×3 / order_logs ×1),把 lint:data-access 顶红了
// (基线 0 → 实际 4)。按 ADR-006 棘轮的指引,新读写一律收口到 repository,
// 而不是给业务层开白名单。
//
// 本文件只做 persistence:**放不放货、能不能完结、要不要转财务审批**
// 这些判定留在 action/domain,这里只回答「库里有没有这条记录」。
// ============================================================

export interface ShipmentConfirmationInsert {
  orderId: string;
  shipmentQty: number;
  orderQty: number | null;
  customerName: string | null;
  requestedBy: string;
  salesSignId: string;
  salesSignedAt: string;
  status: string;
}

/** 该单是否已有「业务已签、待财务批」的确认单(避免重复转审批)。 */
export async function findPendingSalesSigned(
  client: any,
  orderId: string,
): Promise<{ exists: boolean; error: string | null }> {
  const { data, error } = await client.from('shipment_confirmations')
    .select('id').eq('order_id', orderId).eq('status', 'sales_signed').limit(1);
  if (error) return { exists: false, error: error.message };
  return { exists: !!(data && data.length > 0), error: null };
}

/** 该单是否已有仓库已签的确认单(= 财务放货证据之一)。 */
export async function hasWarehouseSigned(
  client: any,
  orderId: string,
): Promise<{ exists: boolean; error: string | null }> {
  const { data, error } = await client.from('shipment_confirmations')
    .select('id').eq('order_id', orderId).eq('status', 'warehouse_signed').limit(1);
  if (error) return { exists: false, error: error.message };
  return { exists: !!(data && data.length > 0), error: null };
}

/**
 * 站内放货证据:order_logs 里的 business_override / critical_mutation:order_financials
 * 且注记含放货字样。
 *
 * ⚠️ 口径原样搬运,一个字都没改 —— 这是「财务是否放过货」的判定依据,
 * 收口重构不该顺手改变它的语义。
 */
export async function hasFinanceReleaseLog(
  client: any,
  orderId: string,
): Promise<{ exists: boolean; error: string | null }> {
  const { data, error } = await client.from('order_logs')
    .select('id')
    .eq('order_id', orderId)
    .in('action', ['business_override', 'critical_mutation:order_financials'])
    .or('note.ilike.%放货%,note.ilike.%允许出货%,note.ilike.%allow_shipment%')
    .limit(1);
  if (error) return { exists: false, error: error.message };
  return { exists: !!(data && data.length > 0), error: null };
}

/** 建出货确认单(转财务审批用)。返回新建的 id。 */
export async function createShipmentConfirmationRow(
  client: any,
  input: ShipmentConfirmationInsert,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client.from('shipment_confirmations')
    .insert({
      order_id: input.orderId,
      shipment_qty: input.shipmentQty,
      order_qty: input.orderQty,
      customer_name: input.customerName,
      requested_by: input.requestedBy,
      sales_sign_id: input.salesSignId,
      sales_signed_at: input.salesSignedAt,
      status: input.status,
    })
    .select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: (data as any)?.id ?? null, error: null };
}
