/**
 * 订单节拍排期引擎 V3.2
 *
 * 标准交期：45天 | 生产周期：20-22天
 * 全部自然日，不跳周末
 *
 * 45天时间线：
 *   T+0   PO确认
 *   T+1   财务审核
 *   T+2   生产单上传 + 采购下达 + 加工费确认
 *   T+3   辅料单/BOM齐全 + 大货原辅料确认 + 确认工厂
 *   T+5   产前样准备完成
 *   T+6   产前样寄出
 *   T+10  产前样客户确认
 *   T+12  原辅料到货
 *   T+11  产前会
 *   T+12  生产启动
 *   ──── 生产期 20-22 天 ────
 *   A-15  中查（生产约10天后）
 *   A-10  包装确认
 *   A-8   尾查
 *   A-7   工厂完成
 *   A-6   验货放行 + 船样寄送
 *   A-5   订舱(FOB) / A-18(DDP)
 *   A-2   报关出运
 *   A+30  收款
 */

/** 解析日期为北京时间 0 点 */
function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  // 固定为北京时间 UTC+8
  return new Date(s + 'T00:00:00+08:00');
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
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
  const A = new Date(anchorStr + 'T00:00:00+08:00');

  const cap = (d: Date): Date => d > A ? new Date(A) : d;

  const shippingSample = shippingSampleRequired && shippingSampleDeadline
    ? parseDate(shippingSampleDeadline)!
    : addDays(A, -6);

  return {
    // ── 阶段1：订单启动（T+0 ~ T+1）──
    po_confirmed:                  cap(T0),
    finance_approval:              cap(addDays(T0, 1)),
    production_order_upload:       cap(addDays(T0, 2)),

    // ── 阶段2：订单转化（T+2 ~ T+3）──
    order_docs_bom_complete:       cap(addDays(T0, 3)),
    bulk_materials_confirmed:      cap(addDays(T0, 3)),

    // ── 阶段3：工厂 & 产前样（T+2 ~ T+10）──
    processing_fee_confirmed:      cap(addDays(T0, 2)),
    factory_confirmed:             cap(addDays(T0, 3)),
    pre_production_sample_ready:   cap(addDays(T0, 5)),
    pre_production_sample_sent:    cap(addDays(T0, 6)),
    pre_production_sample_approved: cap(addDays(T0, 10)),

    // ── 阶段4：采购 & 生产（T+2 ~ T+12）──
    procurement_order_placed:      cap(addDays(T0, 2)),
    materials_received_inspected:  cap(addDays(T0, 12)),
    pre_production_meeting:        cap(addDays(T0, 11)),
    production_kickoff:            cap(addDays(T0, 12)),

    // ── 阶段5：过程控制（倒排）──
    mid_qc_check:                  cap(addDays(A, -15)),
    final_qc_check:                cap(addDays(A, -8)),

    // ── 阶段6：出货控制（倒排）──
    packing_method_confirmed:      cap(addDays(A, -10)),
    factory_completion:            cap(addDays(A, -7)),
    inspection_release:            cap(addDays(A, -6)),
    shipping_sample_send:          cap(shippingSample),

    // ── 阶段7：物流收款（倒排）──
    booking_done:                  cap(addDays(A, incoterm === 'FOB' ? -5 : -18)),
    customs_export:                cap(addDays(A, -2)),
    payment_received:              addDays(A, 30),
  };
}
