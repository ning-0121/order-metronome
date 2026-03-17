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
  /** 订单日期（客户PO日期，新模型的T0） */
  orderDate?: string | null;
  /** 兼容旧模型：系统创建时间 */
  createdAt?: Date;
  incoterm: 'FOB' | 'DDP';
  etd?: string | null;
  /** DDP到仓日期（兼容旧字段名） */
  warehouseDueDate?: string | null;
  /** DDP到港日期（新字段名） */
  eta?: string | null;
  packagingType?: 'standard' | 'custom';
  orderType?: 'sample' | 'bulk' | 'repeat';
  shippingSampleRequired?: boolean;
  shippingSampleDeadline?: string | null;
}

/**
 * PO 级里程碑排期计算
 * T0 = order_date（客户PO日期）
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

  // T0：优先用 order_date，兜底用 createdAt
  const T0 = parseDate(orderDate) ?? createdAt ?? new Date();

  // Anchor：FOB=ETD，DDP=eta 或 warehouseDueDate
  const anchorStr = incoterm === 'FOB' ? etd : (eta || warehouseDueDate);
  if (!anchorStr) {
    throw new Error('Missing anchor date: ' + (incoterm === 'FOB' ? 'ETD' : 'ETA/warehouse_due_date') + ' is required');
  }
  const anchor = new Date(anchorStr + 'T00:00:00');

  // ── 样品单排期（更短周期）──
  if (orderType === 'sample') {
    return {
      po_confirmed:                  shiftWeekendToFriday(T0),
      finance_approval:              shiftWeekendToFriday(addWorkdays(T0, 1)),
      order_docs_complete:           shiftWeekendToFriday(addWorkdays(T0, 2)),
      rm_purchase_sheet_submit:      shiftWeekendToFriday(addWorkdays(T0, 2)),
      finance_purchase_approval:     shiftWeekendToFriday(addWorkdays(T0, 3)),
      procurement_order_placed:      shiftWeekendToFriday(addWorkdays(T0, 3)),
      materials_received_inspected:  shiftWeekendToFriday(addWorkdays(T0, 7)),
      pps_ready:                     shiftWeekendToFriday(addWorkdays(T0, 7)),
      pps_sent:                      shiftWeekendToFriday(addWorkdays(T0, 8)),
      pps_customer_approved:         shiftWeekendToFriday(addWorkdays(T0, 12)),
      production_start:              shiftWeekendToFriday(addWorkdays(T0, 13)),
      mid_qc_check:                  shiftWeekendToFriday(addWorkdays(T0, 18)),
      final_qc_check:                daysOffset(anchor, -5),
      packaging_materials_ready:     daysOffset(anchor, -7),
      packing_labeling_done:         daysOffset(anchor, -3),
      booking_done:                  incoterm === 'FOB' ? daysOffset(anchor, -7) : daysOffset(anchor, -14),
      shipping_sample_send:          shippingSampleRequired && shippingSampleDeadline
                                       ? shiftWeekendToFriday(parseDate(shippingSampleDeadline)!)
                                       : daysOffset(anchor, -14),
      shipment_done:                 shiftWeekendToFriday(anchor),
      payment_received:              daysOffset(anchor, 30),
    };
  }

  // ── 大货 / 翻单排期 ──
  // 生产线下（出货前7天）
  const productionOffline   = daysOffset(anchor, -7);
  // 生产启动（线下前20个工作日）
  const productionStart     = subtractWorkingDays(productionOffline, 20);
  // 产前样客确（生产启动前2个工作日）
  const ppsCustomerApproved = subtractWorkingDays(productionStart, 2);
  // 产前样寄出（客确前3天）
  const ppsSent             = daysOffset(ppsCustomerApproved, -3);
  // 产前样准备（寄出前2天）
  const ppsReady            = daysOffset(ppsSent, -2);
  // 采购下达（生产启动前5个工作日）
  const procurementPlaced   = subtractWorkingDays(productionStart, 5);
  // 原辅料到货验收（生产启动前2个工作日）
  const materialsReceived   = subtractWorkingDays(productionStart, 2);
  // 中查（生产启动后10个工作日）
  const midQc               = addWorkdays(productionStart, 10);
  // 尾查（线下前9天）
  const finalQc             = daysOffset(anchor, -9);
  // 包材到位（线下前14天）
  const packagingReady      = daysOffset(anchor, -14);
  // 包装贴标（线下前8天）
  const packingDone         = daysOffset(anchor, -8);
  // 订舱（FOB线下前7天 / DDP到仓前21天）
  const bookingDone         = incoterm === 'FOB'
    ? daysOffset(anchor, -7)
    : daysOffset(anchor, -21);
  // Shipping Sample（如需要，用指定截止日；否则订舱前7天）
  const shippingSampleSend  = shippingSampleRequired && shippingSampleDeadline
    ? shiftWeekendToFriday(parseDate(shippingSampleDeadline)!)
    : daysOffset(bookingDone, -7);

  return {
    // A. 订单启动（7）
    po_confirmed:                  shiftWeekendToFriday(T0),
    finance_approval:              shiftWeekendToFriday(addWorkdays(T0, 2)),
    order_docs_complete:           shiftWeekendToFriday(addWorkdays(T0, 3)),
    rm_purchase_sheet_submit:      shiftWeekendToFriday(addWorkdays(T0, 2)),
    finance_purchase_approval:     shiftWeekendToFriday(addWorkdays(T0, 2)),
    procurement_order_placed:      shiftWeekendToFriday(procurementPlaced),
    materials_received_inspected:  shiftWeekendToFriday(materialsReceived),
    // B. 产前样 & 生产（4）
    pps_ready:                     shiftWeekendToFriday(ppsReady),
    pps_sent:                      shiftWeekendToFriday(ppsSent),
    pps_customer_approved:         shiftWeekendToFriday(ppsCustomerApproved),
    production_start:              shiftWeekendToFriday(productionStart),
    // C. 生产出货（5）
    mid_qc_check:                  shiftWeekendToFriday(midQc),
    final_qc_check:                shiftWeekendToFriday(finalQc),
    packaging_materials_ready:     shiftWeekendToFriday(packagingReady),
    packing_labeling_done:         shiftWeekendToFriday(packingDone),
    booking_done:                  shiftWeekendToFriday(bookingDone),
    // 附加：Shipping Sample
    shipping_sample_send:          shiftWeekendToFriday(shippingSampleSend),
    // D. 出运收款（2）
    shipment_done:                 shiftWeekendToFriday(anchor),
    payment_received:              daysOffset(anchor, 30),
  };
}
