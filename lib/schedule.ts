import { subtractWorkingDays } from './utils/date';

function shiftWeekendToFriday(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  if (day === 6) r.setDate(r.getDate() - 1);
  if (day === 0) r.setDate(r.getDate() - 2);
  return r;
}

function addWorkdays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

function offset(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return shiftWeekendToFriday(d);
}

function parseDate(s?: string | null): Date | null {
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
  orderType?: 'sample' | 'bulk' | 'repeat';
  shippingSampleRequired?: boolean;
  shippingSampleDeadline?: string | null;
}

/**
 * 最终 V1 排期计算（21节点）
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
  if (!anchorStr) throw new Error('Missing anchor: ' + (incoterm === 'FOB' ? 'ETD' : 'ETA') + ' required');
  const anchor = new Date(anchorStr + 'T00:00:00');

  // ── 共用倒排锚点 ──
  const ppsSampleReady    = offset(anchor, -23);
  const ppsSampleSent     = offset(anchor, -21);
  const ppsSampleApproved = offset(anchor, -18);
  const finalQc           = offset(anchor, -7);
  const packingConfirm    = shiftWeekendToFriday(addWorkdays(finalQc, 1));
  const factoryCompletion = offset(anchor, -8);
  const inspectionRelease = offset(anchor, -7);
  const shippingSample    = shippingSampleRequired && shippingSampleDeadline
    ? shiftWeekendToFriday(parseDate(shippingSampleDeadline)!)
    : offset(anchor, -7);
  const bookingDone       = offset(anchor, incoterm === 'FOB' ? -5 : -21);
  const customsExport     = offset(anchor, -3);

  // 生产启动 = 产前样确认后次日
  const productionKickoff    = shiftWeekendToFriday(addWorkdays(ppsSampleApproved, 1));
  const preProductionMeeting = subtractWorkingDays(productionKickoff, 1);
  const midQc                = addWorkdays(productionKickoff, 10);

  // 采购 = T0+2工作日；物料到位 = 采购下单后14天
  const procurementPlaced   = shiftWeekendToFriday(addWorkdays(T0, 2));
  const materialsReceived   = offset(procurementPlaced, 14);

  // 大货原辅料确认 = 采购前3工作日
  const bulkMaterialsConfirmed = subtractWorkingDays(procurementPlaced, 3);

  // 样品单用稍短的生产启动时间
  const productionKickoffSample = shiftWeekendToFriday(addWorkdays(ppsSampleApproved, 1));

  // 加工费确认 = T0+3工作日
  const processingFeeConfirmed = shiftWeekendToFriday(addWorkdays(T0, 3));
  // 确认工厂 = 产前样准备前2工作日（先选工厂再做产前样）
  const factoryConfirmed = subtractWorkingDays(ppsSampleReady, 2);

  return {
    // 阶段1：订单启动
    po_confirmed:                  shiftWeekendToFriday(T0),
    finance_approval:              shiftWeekendToFriday(addWorkdays(T0, 1)),
    production_order_upload:       shiftWeekendToFriday(addWorkdays(T0, 3)),
    // 阶段2：订单转化
    order_docs_bom_complete:       shiftWeekendToFriday(addWorkdays(T0, 2)),
    bulk_materials_confirmed:      shiftWeekendToFriday(bulkMaterialsConfirmed),
    // 阶段3：工厂选定+产前样（加工费→确认工厂→准备→寄出→客户确认）
    processing_fee_confirmed:      shiftWeekendToFriday(processingFeeConfirmed),
    factory_confirmed:             shiftWeekendToFriday(factoryConfirmed),
    pre_production_sample_ready:   shiftWeekendToFriday(ppsSampleReady),
    pre_production_sample_sent:    shiftWeekendToFriday(ppsSampleSent),
    pre_production_sample_approved: shiftWeekendToFriday(ppsSampleApproved),
    // 阶段4：采购与生产
    procurement_order_placed:      shiftWeekendToFriday(procurementPlaced),
    materials_received_inspected:  shiftWeekendToFriday(materialsReceived),
    production_kickoff:            orderType === 'sample' ? productionKickoffSample : shiftWeekendToFriday(productionKickoff),
    pre_production_meeting:        shiftWeekendToFriday(preProductionMeeting),
    // 阶段5：过程控制
    mid_qc_check:                  shiftWeekendToFriday(midQc),
    final_qc_check:                shiftWeekendToFriday(finalQc),
    // 阶段6：出货控制
    packing_method_confirmed:      shiftWeekendToFriday(packingConfirm),
    factory_completion:            shiftWeekendToFriday(factoryCompletion),
    inspection_release:            shiftWeekendToFriday(inspectionRelease),
    shipping_sample_send:          shiftWeekendToFriday(shippingSample),
    // 阶段7：物流收款
    booking_done:                  shiftWeekendToFriday(bookingDone),
    customs_export:                shiftWeekendToFriday(customsExport),
    payment_received:              offset(anchor, 30),
  };
}
