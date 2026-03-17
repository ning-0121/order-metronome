import { subtractWorkingDays } from './utils/date';

function shiftWeekendToFriday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  if (day === 6) d.setDate(d.getDate() - 1);
  if (day === 0) d.setDate(d.getDate() - 2);
  return d;
}

function addWorkdays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

function daysOffset(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return shiftWeekendToFriday(d);
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(s + 'T00:00:00');
}

export interface CalcDueDatesParams {
  orderDate?: string | null;
  createdAt?: Date;
  incoterm: 'FOB' | 'DDP';
  etd?: string | null;
  warehouseDueDate?: string | null;
  eta?: string | null;
  packagingType?: 'standard' | 'custom';
  orderType?: 'sample' | 'bulk' | 'repeat';
  shippingSampleRequired?: boolean;
  shippingSampleDeadline?: string | null;
}

/**
 * V3 PO 级里程碑排期（22节点）
 * T0 = order_date
 * Anchor = FOB→ETD / DDP→ETA or warehouseDueDate
 */
export function calcDueDates(params: CalcDueDatesParams) {
  const {
    orderDate, createdAt, incoterm,
    etd, warehouseDueDate, eta,
    orderType = 'bulk',
    shippingSampleRequired = false,
    shippingSampleDeadline,
  } = params;

  const T0 = parseDate(orderDate) ?? createdAt ?? new Date();

  const anchorStr = incoterm === 'FOB' ? etd : (eta || warehouseDueDate);
  if (!anchorStr) {
    throw new Error('Missing anchor date: ' + (incoterm === 'FOB' ? 'ETD' : 'ETA/warehouse_due_date') + ' is required');
  }
  const anchor = new Date(anchorStr + 'T00:00:00');

  // ── 样品单排期（短周期，约 4-6 周）──
  if (orderType === 'sample') {
    const ppsSampleReady    = shiftWeekendToFriday(addWorkdays(T0, 7));
    const ppsSampleSent     = shiftWeekendToFriday(addWorkdays(T0, 8));
    const ppsSampleApproved = shiftWeekendToFriday(addWorkdays(T0, 12));
    const productionStart   = shiftWeekendToFriday(addWorkdays(T0, 13));
    const bookingDone       = incoterm === 'FOB' ? daysOffset(anchor, -7) : daysOffset(anchor, -14);

    return {
      po_confirmed:                     shiftWeekendToFriday(T0),
      finance_approval:                 shiftWeekendToFriday(addWorkdays(T0, 1)),
      order_docs_complete:              shiftWeekendToFriday(addWorkdays(T0, 2)),
      bulk_materials_confirmed:         shiftWeekendToFriday(addWorkdays(T0, 2)),
      finance_purchase_approval:        shiftWeekendToFriday(addWorkdays(T0, 3)),
      procurement_order_placed:         shiftWeekendToFriday(addWorkdays(T0, 3)),
      materials_received_inspected:     shiftWeekendToFriday(addWorkdays(T0, 7)),
      pre_production_sample_ready:      ppsSampleReady,
      pre_production_sample_sent:       ppsSampleSent,
      pre_production_sample_approved:   ppsSampleApproved,
      production_start:                 productionStart,
      mid_qc_check:                     shiftWeekendToFriday(addWorkdays(productionStart, 5)),
      final_qc_check:                   daysOffset(anchor, -5),
      packing_method_confirmed:         daysOffset(anchor, -4),
      packaging_materials_ready:        daysOffset(anchor, -7),
      packing_labeling_done:            daysOffset(anchor, -3),
      booking_done:                     bookingDone,
      shipping_sample_send:             shippingSampleRequired && shippingSampleDeadline
                                          ? shiftWeekendToFriday(parseDate(shippingSampleDeadline)!)
                                          : daysOffset(anchor, -14),
      shipping_sample_approved:         shippingSampleRequired && shippingSampleDeadline
                                          ? daysOffset(parseDate(shippingSampleDeadline)!, 5)
                                          : daysOffset(anchor, -10),
      shipment_done:                    shiftWeekendToFriday(anchor),
      payment_received:                 daysOffset(anchor, 30),
    };
  }

  // ── 大货 / 翻单排期 ──

  // 生产线下（出货前7天）
  const productionOffline = daysOffset(anchor, -7);

  // 生产启动（线下前20工作日）
  const productionStart = subtractWorkingDays(productionOffline, 20);

  // 产前样链（从生产启动倒推）
  // 客确前2工作日 = 生产启动被阻断点
  const ppsApproved = subtractWorkingDays(productionStart, 2);
  // 寄出后等待客确约 5 天
  const ppsSent     = daysOffset(ppsApproved, -5);
  // 样衣完成后寄出，约 2 天准备
  const ppsReady    = daysOffset(ppsSent, -2);

  // 原辅料验收（生产启动前2工作日）
  const materialsReceived = subtractWorkingDays(productionStart, 2);

  // 采购下达（原辅料验收前 lead-time，约14天）
  const procurementPlaced = daysOffset(materialsReceived, -14);

  // 大货原辅料确认（采购下达前3工作日）
  const bulkMaterialsConfirmed = subtractWorkingDays(procurementPlaced, 3);

  // 财务采购审核（采购下达前2工作日）
  const financePurchaseApproval = subtractWorkingDays(procurementPlaced, 2);

  // 中查（生产启动后10工作日）
  const midQc = addWorkdays(productionStart, 10);

  // 尾查（线下前9天）
  const finalQc = daysOffset(anchor, -9);

  // 装箱方式确认（尾查后次日）
  const packingMethodConfirmed = shiftWeekendToFriday(addWorkdays(finalQc, 1));

  // 包材到位（线下前14天）
  const packagingReady = daysOffset(anchor, -14);

  // 装箱贴标（线下前8天）
  const packingDone = daysOffset(anchor, -8);

  // 订舱（FOB线下前7天 / DDP到仓前21天）
  const bookingDone = incoterm === 'FOB'
    ? daysOffset(anchor, -7)
    : daysOffset(anchor, -21);

  // Shipping Sample
  const shippingSampleSend = shippingSampleRequired && shippingSampleDeadline
    ? shiftWeekendToFriday(parseDate(shippingSampleDeadline)!)
    : daysOffset(bookingDone, -10);
  const shippingSampleApproved = shippingSampleRequired && shippingSampleDeadline
    ? daysOffset(parseDate(shippingSampleDeadline)!, 5)
    : daysOffset(bookingDone, -5);

  return {
    // A. 订单启动（7）
    po_confirmed:                     shiftWeekendToFriday(T0),
    finance_approval:                 shiftWeekendToFriday(addWorkdays(T0, 2)),
    order_docs_complete:              shiftWeekendToFriday(addWorkdays(T0, 3)),
    bulk_materials_confirmed:         shiftWeekendToFriday(bulkMaterialsConfirmed),
    finance_purchase_approval:        shiftWeekendToFriday(financePurchaseApproval),
    procurement_order_placed:         shiftWeekendToFriday(procurementPlaced),
    materials_received_inspected:     shiftWeekendToFriday(materialsReceived),
    // B. 产前样（3）
    pre_production_sample_ready:      shiftWeekendToFriday(ppsReady),
    pre_production_sample_sent:       shiftWeekendToFriday(ppsSent),
    pre_production_sample_approved:   shiftWeekendToFriday(ppsApproved),
    // C. 生产（2）
    production_start:                 shiftWeekendToFriday(productionStart),
    mid_qc_check:                     shiftWeekendToFriday(midQc),
    // D. QC + 出货准备（5）
    final_qc_check:                   shiftWeekendToFriday(finalQc),
    packing_method_confirmed:         shiftWeekendToFriday(packingMethodConfirmed),
    packaging_materials_ready:        shiftWeekendToFriday(packagingReady),
    packing_labeling_done:            shiftWeekendToFriday(packingDone),
    booking_done:                     shiftWeekendToFriday(bookingDone),
    // E. Shipping Sample（条件）
    shipping_sample_send:             shiftWeekendToFriday(shippingSampleSend),
    shipping_sample_approved:         shiftWeekendToFriday(shippingSampleApproved),
    // F. 出运收款（2）
    shipment_done:                    shiftWeekendToFriday(anchor),
    payment_received:                 daysOffset(anchor, 30),
  };
}
