import { subtractWorkingDays } from './utils/date';

// 公司6天工作制：周一到周六上班，只有周日休息
// 如果落在周日，往前挪到周六（倒排用）
function skipSundayBack(d: Date): Date {
  const r = new Date(d);
  if (r.getDay() === 0) r.setDate(r.getDate() - 1);
  return r;
}

// 如果落在周日，往后挪到周一（正推用）
function skipSundayForward(d: Date): Date {
  const r = new Date(d);
  if (r.getDay() === 0) r.setDate(r.getDate() + 1);
  return r;
}

// 加工作日（只跳周日）
function addWorkdays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) added++;
  }
  return d;
}

function offset(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return skipSundayBack(d);
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
  const packingConfirm    = skipSundayBack(addWorkdays(finalQc, 1));
  const factoryCompletion = offset(anchor, -8);
  const inspectionRelease = offset(anchor, -7);
  const shippingSample    = shippingSampleRequired && shippingSampleDeadline
    ? skipSundayBack(parseDate(shippingSampleDeadline)!)
    : offset(anchor, -7);
  const bookingDone       = offset(anchor, incoterm === 'FOB' ? -5 : -21);
  const customsExport     = offset(anchor, -3);

  // 生产启动 = 产前样确认后次日
  const productionKickoff    = skipSundayBack(addWorkdays(ppsSampleApproved, 1));
  const preProductionMeeting = subtractWorkingDays(productionKickoff, 1);
  const midQc                = addWorkdays(productionKickoff, 10);

  // 采购 = T0+2工作日；物料到位 = 采购下单后14天
  const procurementPlaced   = skipSundayBack(addWorkdays(T0, 2));
  const materialsReceived   = offset(procurementPlaced, 14);

  // 大货原辅料确认 = 采购前3工作日
  const bulkMaterialsConfirmed = subtractWorkingDays(procurementPlaced, 3);

  // 样品单用稍短的生产启动时间
  const productionKickoffSample = skipSundayBack(addWorkdays(ppsSampleApproved, 1));

  // 加工费确认 = T0+3工作日
  const processingFeeConfirmed = skipSundayBack(addWorkdays(T0, 3));
  // 确认工厂 = 产前样准备前2工作日（先选工厂再做产前样）
  const factoryConfirmed = subtractWorkingDays(ppsSampleReady, 2);

  // 安全边界：除了收款，所有关卡截止日不能晚于交期
  const cap = (d: Date): Date => {
    if (d > anchor) return new Date(anchor);
    return d;
  };

  return {
    // 阶段1：订单启动（从下单日正推，周末往后挪不往前，且不超过交期）
    po_confirmed:                  cap(skipSundayForward(T0)),
    finance_approval:              cap(skipSundayForward(addWorkdays(T0, 1))),
    production_order_upload:       cap(skipSundayForward(addWorkdays(T0, 2))),
    // 阶段2：订单转化
    order_docs_bom_complete:       cap(skipSundayForward(addWorkdays(T0, 2))),
    bulk_materials_confirmed:      cap(skipSundayBack(bulkMaterialsConfirmed)),
    // 阶段3：工厂选定+产前样（加工费→确认工厂→准备→寄出→客户确认）
    processing_fee_confirmed:      cap(skipSundayBack(processingFeeConfirmed)),
    factory_confirmed:             cap(skipSundayBack(factoryConfirmed)),
    pre_production_sample_ready:   cap(skipSundayBack(ppsSampleReady)),
    pre_production_sample_sent:    cap(skipSundayBack(ppsSampleSent)),
    pre_production_sample_approved: cap(skipSundayBack(ppsSampleApproved)),
    // 阶段4：采购与生产
    procurement_order_placed:      cap(skipSundayBack(procurementPlaced)),
    materials_received_inspected:  cap(skipSundayBack(materialsReceived)),
    production_kickoff:            cap(orderType === 'sample' ? productionKickoffSample : skipSundayBack(productionKickoff)),
    pre_production_meeting:        cap(skipSundayBack(preProductionMeeting)),
    // 阶段5：过程控制
    mid_qc_check:                  cap(skipSundayBack(midQc)),
    final_qc_check:                cap(skipSundayBack(finalQc)),
    // 阶段6：出货控制
    packing_method_confirmed:      cap(skipSundayBack(packingConfirm)),
    factory_completion:            cap(skipSundayBack(factoryCompletion)),
    inspection_release:            cap(skipSundayBack(inspectionRelease)),
    shipping_sample_send:          cap(skipSundayBack(shippingSample)),
    // 阶段7：物流收款
    booking_done:                  cap(skipSundayBack(bookingDone)),
    customs_export:                cap(skipSundayBack(customsExport)),
    payment_received:              offset(anchor, 30), // 收款可以在交期后
  };
}
