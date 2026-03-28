/**
 * 订单节拍排期引擎 V2
 *
 * 设计原则：
 * 1. 全部使用自然日，不跳周末
 * 2. 以交期（Anchor）为终点倒排，以下单日（T0）为起点正推
 * 3. 两者取较早的那个，确保所有关卡都在交期前完成
 * 4. 除收款外，所有关卡截止日不能晚于交期
 *
 * 锚点：
 *   FOB → ETD（预计离港日）
 *   DDP → ETA/到仓日期
 *
 * 典型时间线（以90天交期为例）：
 *   T0        PO确认（当天）
 *   T0+1      财务审核
 *   T0+2      生产单上传
 *   A-60      辅料单/BOM齐全（包装前20天，约交期前60天）
 *   T0+3      采购订单下达
 *   T0+3      加工费确认
 *   A-55      大货原辅料确认
 *   A-50      确认工厂
 *   A-45      产前样准备完成
 *   A-40      产前样寄出
 *   A-33      产前样客户确认
 *   T0+17     原辅料到货验收（采购后14天）
 *   A-32      产前会
 *   A-30      生产启动/开裁
 *   A-18      中查（生产启动后12天）
 *   A-10      尾查
 *   A-12      包装方式确认
 *   A-9       工厂完成
 *   A-8       验货/放行
 *   A-10      船样寄送
 *   A-7(FOB)  订舱完成 / A-25(DDP)
 *   A-3       报关出运
 *   A+30      收款完成
 */

function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  return new Date(s + 'T00:00:00');
}

/** 自然日偏移（正数=往后，负数=往前） */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** 取两个日期中较早的 */
function earlier(a: Date, b: Date): Date {
  return a < b ? a : b;
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

export function calcDueDates(params: CalcDueDatesParams) {
  const {
    orderDate, createdAt, incoterm,
    etd, warehouseDueDate, eta,
    shippingSampleRequired = false,
    shippingSampleDeadline,
  } = params;

  const T0 = parseDate(orderDate) ?? createdAt ?? new Date();
  const anchorStr = incoterm === 'FOB' ? etd : (eta || warehouseDueDate);
  if (!anchorStr) throw new Error('Missing anchor: ' + (incoterm === 'FOB' ? 'ETD' : 'ETA/到仓日') + ' required');
  const A = new Date(anchorStr + 'T00:00:00');

  // 安全边界：除收款外不能晚于交期
  const cap = (d: Date): Date => d > A ? new Date(A) : d;

  // ════════════════════════════════════════════
  // 阶段 1：订单启动（从下单日正推）
  // ════════════════════════════════════════════
  const poConfirmed          = T0;                  // 当天
  const financeApproval      = addDays(T0, 1);      // T0+1
  const productionOrderUpload = addDays(T0, 2);     // T0+2

  // ════════════════════════════════════════════
  // 阶段 2：订单转化
  // ════════════════════════════════════════════
  const orderDocsBom         = addDays(A, -40);     // 交期前40天（辅料单要早）
  const bulkMaterials        = addDays(A, -50);     // 交期前50天

  // ════════════════════════════════════════════
  // 阶段 3：工厂选定 & 产前样
  // ════════════════════════════════════════════
  const processingFee        = addDays(T0, 3);      // T0+3
  const factoryConfirmed     = addDays(A, -50);     // 交期前50天
  const ppsSampleReady       = addDays(A, -45);     // 交期前45天
  const ppsSampleSent        = addDays(A, -40);     // 交期前40天
  const ppsSampleApproved    = addDays(A, -33);     // 交期前33天

  // ════════════════════════════════════════════
  // 阶段 4：采购与生产
  // ════════════════════════════════════════════
  const procurementPlaced    = addDays(T0, 3);      // T0+3
  const materialsReceived    = addDays(T0, 17);     // T0+17（采购后14天到货）
  const preProductionMeeting = addDays(A, -32);     // 交期前32天
  const productionKickoff    = addDays(A, -30);     // 交期前30天

  // ════════════════════════════════════════════
  // 阶段 5：过程控制
  // ════════════════════════════════════════════
  const midQc                = addDays(A, -18);     // 交期前18天
  const finalQc              = addDays(A, -10);     // 交期前10天

  // ════════════════════════════════════════════
  // 阶段 6：出货控制
  // ════════════════════════════════════════════
  const packingConfirm       = addDays(A, -12);     // 交期前12天
  const factoryCompletion    = addDays(A, -9);      // 交期前9天
  const inspectionRelease    = addDays(A, -8);      // 交期前8天
  const shippingSample       = shippingSampleRequired && shippingSampleDeadline
    ? parseDate(shippingSampleDeadline)!
    : addDays(A, -10);                              // 交期前10天

  // ════════════════════════════════════════════
  // 阶段 7：物流收款
  // ════════════════════════════════════════════
  const bookingDone          = addDays(A, incoterm === 'FOB' ? -7 : -25); // FOB交期前7天 / DDP前25天
  const customsExport        = addDays(A, -3);      // 交期前3天
  const paymentReceived      = addDays(A, 30);      // 交期后30天

  return {
    po_confirmed:                  cap(poConfirmed),
    finance_approval:              cap(financeApproval),
    production_order_upload:       cap(productionOrderUpload),

    order_docs_bom_complete:       cap(earlier(orderDocsBom, addDays(T0, 5))),
    bulk_materials_confirmed:      cap(earlier(bulkMaterials, addDays(T0, 5))),

    processing_fee_confirmed:      cap(processingFee),
    factory_confirmed:             cap(earlier(factoryConfirmed, addDays(T0, 5))),
    pre_production_sample_ready:   cap(ppsSampleReady),
    pre_production_sample_sent:    cap(ppsSampleSent),
    pre_production_sample_approved: cap(ppsSampleApproved),

    procurement_order_placed:      cap(procurementPlaced),
    materials_received_inspected:  cap(materialsReceived),
    production_kickoff:            cap(productionKickoff),
    pre_production_meeting:        cap(preProductionMeeting),

    mid_qc_check:                  cap(midQc),
    final_qc_check:                cap(finalQc),

    packing_method_confirmed:      cap(packingConfirm),
    factory_completion:            cap(factoryCompletion),
    inspection_release:            cap(inspectionRelease),
    shipping_sample_send:          cap(shippingSample),

    booking_done:                  cap(bookingDone),
    customs_export:                cap(customsExport),
    payment_received:              paymentReceived,
  };
}
