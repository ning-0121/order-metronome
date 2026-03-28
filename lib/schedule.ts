/**
 * 订单节拍排期引擎 V3
 *
 * 适用交期：30-45天（最长60天）
 * 全部自然日，不跳周末
 *
 * 设计原则：
 * 1. 前5天集中处理订单启动（PO确认→财务→生产单→采购→辅料单）
 * 2. 第5-15天完成工厂确认和产前样
 * 3. 第14-20天原辅料到位+生产启动
 * 4. 交期前12天开始中查，交期前7天尾查
 * 5. 最后一周出货（包装→验货→订舱→报关）
 *
 * 典型30天时间线：
 *   T+0   PO确认
 *   T+1   财务审核
 *   T+2   生产单上传
 *   T+3   采购下达 + 加工费确认 + 辅料单/BOM + 大货原辅料确认
 *   T+4   确认工厂
 *   T+7   产前样准备完成
 *   T+8   产前样寄出
 *   T+12  产前样客户确认
 *   T+13  产前会
 *   T+14  生产启动 + 原辅料到货
 *   A-12  中查
 *   A-7   尾查
 *   A-8   包装确认
 *   A-6   工厂完成
 *   A-5   验货放行
 *   A-5   订舱(FOB) / A-15(DDP)
 *   A-5   船样寄送
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

  // 不能晚于交期（收款除外）
  const cap = (d: Date): Date => d > A ? new Date(A) : d;

  // 船样日期
  const shippingSample = shippingSampleRequired && shippingSampleDeadline
    ? parseDate(shippingSampleDeadline)!
    : addDays(A, -5);

  return {
    // ── 阶段1：订单启动（T+0 ~ T+2）──
    po_confirmed:                  cap(T0),                    // 当天
    finance_approval:              cap(addDays(T0, 1)),        // T+1
    production_order_upload:       cap(addDays(T0, 2)),        // T+2

    // ── 阶段2：订单转化（T+3）──
    order_docs_bom_complete:       cap(addDays(T0, 3)),        // T+3 辅料单/BOM
    bulk_materials_confirmed:      cap(addDays(T0, 3)),        // T+3 大货原辅料确认

    // ── 阶段3：工厂 & 产前样（T+3 ~ T+12）──
    processing_fee_confirmed:      cap(addDays(T0, 3)),        // T+3 加工费确认
    factory_confirmed:             cap(addDays(T0, 4)),        // T+4 确认工厂
    pre_production_sample_ready:   cap(addDays(T0, 7)),        // T+7 产前样准备
    pre_production_sample_sent:    cap(addDays(T0, 8)),        // T+8 产前样寄出
    pre_production_sample_approved: cap(addDays(T0, 12)),      // T+12 客户确认

    // ── 阶段4：采购 & 生产（T+3 ~ T+14）──
    procurement_order_placed:      cap(addDays(T0, 3)),        // T+3 采购下达
    materials_received_inspected:  cap(addDays(T0, 14)),       // T+14 原辅料到货（采购后11天）
    pre_production_meeting:        cap(addDays(T0, 13)),       // T+13 产前会
    production_kickoff:            cap(addDays(T0, 14)),       // T+14 生产启动

    // ── 阶段5：过程控制（倒排）──
    mid_qc_check:                  cap(addDays(A, -12)),       // A-12 中查
    final_qc_check:                cap(addDays(A, -7)),        // A-7 尾查

    // ── 阶段6：出货控制（倒排）──
    packing_method_confirmed:      cap(addDays(A, -8)),        // A-8 包装确认
    factory_completion:            cap(addDays(A, -6)),        // A-6 工厂完成
    inspection_release:            cap(addDays(A, -5)),        // A-5 验货放行
    shipping_sample_send:          cap(shippingSample),        // A-5 船样

    // ── 阶段7：物流收款（倒排）──
    booking_done:                  cap(addDays(A, incoterm === 'FOB' ? -5 : -15)), // 订舱
    customs_export:                cap(addDays(A, -2)),        // A-2 报关出运
    payment_received:              addDays(A, 30),             // A+30 收款
  };
}
