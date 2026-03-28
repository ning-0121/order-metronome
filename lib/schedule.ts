/**
 * 订单节拍排期引擎 V3.1
 *
 * 标准交期：45天 | 范围：30-60天
 * 全部自然日，不跳周末
 *
 * 45天标准时间线：
 *   T+0   PO确认
 *   T+1   财务审核
 *   T+2   生产单上传
 *   T+3   采购下达 + 加工费确认
 *   T+5   辅料单/BOM齐全 + 大货原辅料确认
 *   T+5   确认工厂
 *   T+10  产前样准备完成
 *   T+12  产前样寄出
 *   T+18  产前样客户确认
 *   T+17  原辅料到货（采购后14天）
 *   T+19  产前会
 *   T+20  生产启动
 *   A-15  中查（交期前15天）
 *   A-10  包装确认
 *   A-8   尾查
 *   A-7   工厂完成
 *   A-6   验货放行 + 船样寄送
 *   A-5   订舱(FOB) / A-18(DDP)
 *   A-2   报关出运
 *   A+30  收款
 */

function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  return new Date(s + 'T00:00:00');
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
  const A = new Date(anchorStr + 'T00:00:00');

  const cap = (d: Date): Date => d > A ? new Date(A) : d;

  const shippingSample = shippingSampleRequired && shippingSampleDeadline
    ? parseDate(shippingSampleDeadline)!
    : addDays(A, -6);

  return {
    // ── 阶段1：订单启动（T+0 ~ T+2）──
    po_confirmed:                  cap(T0),
    finance_approval:              cap(addDays(T0, 1)),
    production_order_upload:       cap(addDays(T0, 2)),

    // ── 阶段2：订单转化（T+5）──
    order_docs_bom_complete:       cap(addDays(T0, 5)),
    bulk_materials_confirmed:      cap(addDays(T0, 5)),

    // ── 阶段3：工厂 & 产前样（T+3 ~ T+18）──
    processing_fee_confirmed:      cap(addDays(T0, 3)),
    factory_confirmed:             cap(addDays(T0, 5)),
    pre_production_sample_ready:   cap(addDays(T0, 10)),
    pre_production_sample_sent:    cap(addDays(T0, 12)),
    pre_production_sample_approved: cap(addDays(T0, 18)),

    // ── 阶段4：采购 & 生产（T+3 ~ T+20）──
    procurement_order_placed:      cap(addDays(T0, 3)),
    materials_received_inspected:  cap(addDays(T0, 17)),
    pre_production_meeting:        cap(addDays(T0, 19)),
    production_kickoff:            cap(addDays(T0, 20)),

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
