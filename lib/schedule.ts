/**
 * 订单节拍排期引擎 V4
 *
 * 核心逻辑：
 * 1. FOB：Anchor = ETD（离港日），所有排期基于 ETD
 * 2. DDP：Anchor = ETA - 25天（到港日减去海运时间 = 实际出运截止日）
 * 3. 标准周期 45 天，按实际可用天数等比例缩放
 * 4. 全部自然日，北京时间
 *
 * 标准45天时间线（基准比例）：
 *   Day 0   (0%)    PO确认
 *   Day 1   (2%)    财务审核
 *   Day 3   (7%)    订单启动会（财务审核后2日内，参会：CEO/业务/采购/跟单）
 *   Day 2   (4%)    采购下达 + 加工费确认
 *   Day 4   (9%)    生产单上传（启动会后）
 *   Day 3   (7%)    辅料单/BOM + 原辅料确认 + 确认工厂
 *   Day 11  (24%)   产前会
 *   Day 12  (27%)   原辅料到货验收
 *   Day 14  (31%)   产前样准备（原辅料到货后）
 *   Day 15  (33%)   产前样寄出
 *   Day 19  (42%)   客户确认产前样
 *   Day 20  (44%)   生产启动（产前样确认后）
 *   Day 30  (67%)   中查
 *   Day 35  (78%)   包装确认
 *   Day 37  (82%)   尾查
 *   Day 38  (84%)   工厂完成
 *   Day 39  (87%)   验货放行 + 船样
 *   Day 40  (89%)   订舱
 *   Day 43  (96%)   报关安排出运
 *   Day 43  (96%)   核准出运
 *   Day 44  (98%)   出运
 *   Day 45  (100%)  交期/出运截止
 *   Day 75          收款（交期+30）
 */

// DDP 海运时间（中国→美国西海岸约25天）
const DDP_TRANSIT_DAYS = 25;

// 标准周期天数
const STANDARD_DAYS = 45;

// 标准时间线（Day / 45 = 比例）
const TIMELINE = {
  po_confirmed:                  0,
  finance_approval:              1,
  order_kickoff_meeting:         3,
  production_order_upload:       4,
  order_docs_bom_complete:       3,
  bulk_materials_confirmed:      3,
  processing_fee_confirmed:      2,
  factory_confirmed:             3,
  pre_production_sample_ready:   14,
  pre_production_sample_sent:    15,
  pre_production_sample_approved: 19,
  procurement_order_placed:      2,
  materials_received_inspected:  12,
  pre_production_meeting:        11,
  production_kickoff:            20,
  mid_qc_check:                  30,
  final_qc_check:                37,
  packing_method_confirmed:      35,
  factory_completion:            38,
  inspection_release:            39,
  shipping_sample_send:          39,
  booking_done:                  40,
  customs_export:                43,
  finance_shipment_approval:     43,
  shipment_execute:              44,
} as const;

/** 解析日期为北京时间 0 点 */
function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  return new Date(s + 'T00:00:00+08:00');
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + Math.round(days));
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

/**
 * 历史订单导入：重算当前及之后节点的 due_at
 *
 * 算法：将剩余节点按标准时间线中的相对位置，
 * 等比例映射到 [today, anchor] 区间。
 * 如果 anchor 已过，使用 today + 14天 作为最低保障。
 */
export function recalcRemainingDueDates(
  currentStepKey: string,
  anchor: Date,
  today: Date = new Date(),
): Record<string, Date> {
  const currentDay = TIMELINE[currentStepKey as keyof typeof TIMELINE];
  if (currentDay === undefined) throw new Error(`Unknown step_key: ${currentStepKey}`);

  const daysToAnchor = Math.ceil((anchor.getTime() - today.getTime()) / 86400000);
  const availableDays = Math.max(daysToAnchor, 14); // 最低14天保障

  const result: Record<string, Date> = {};

  // 收集当前及之后的所有节点，按标准天数排序
  const remainingEntries = Object.entries(TIMELINE)
    .filter(([, day]) => day >= currentDay)
    .sort(([, a], [, b]) => a - b);

  if (remainingEntries.length <= 1) {
    // 边界：只剩当前节点（或无剩余），当前节点设为今天
    for (const [key] of remainingEntries) {
      result[key] = new Date(today);
    }
  } else {
    // 正常计算：当前节点 = today，最后一个节点 = today + availableDays
    const firstDay = remainingEntries[0][1];
    const lastDay = remainingEntries[remainingEntries.length - 1][1];
    const span = lastDay - firstDay;

    for (const [key, day] of remainingEntries) {
      if (span <= 0) {
        result[key] = new Date(today);
      } else {
        const relativeProgress = (day - firstDay) / span;
        result[key] = addDays(today, Math.round(relativeProgress * availableDays));
      }
    }
  }

  // 收款节点特殊处理：anchor + 30天
  result['payment_received'] = addDays(anchor, 30);

  return result;
}

export function calcDueDates(params: CalcDueDatesParams) {
  const {
    orderDate, createdAt, incoterm,
    etd, warehouseDueDate, eta,
    shippingSampleRequired = false,
    shippingSampleDeadline,
  } = params;

  const T0 = parseDate(orderDate) ?? createdAt ?? new Date();

  // 计算实际锚点
  // FOB: 锚点 = ETD（离港日）
  // DDP: 锚点 = ETA - 25天海运 = 实际必须出运的日期
  let anchorStr: string | null | undefined;
  if (incoterm === 'FOB') {
    anchorStr = etd;
  } else {
    anchorStr = eta || warehouseDueDate;
  }
  if (!anchorStr) throw new Error('Missing: ' + (incoterm === 'FOB' ? 'ETD' : 'ETA/到仓日') + ' required');

  const rawAnchor = new Date(anchorStr + 'T00:00:00+08:00');

  // DDP 需要减去海运时间得到实际出运截止日
  const A = incoterm === 'DDP' ? addDays(rawAnchor, -DDP_TRANSIT_DAYS) : rawAnchor;

  // 实际可用天数
  const availableDays = Math.ceil((A.getTime() - T0.getTime()) / 86400000);

  // 缩放比例（实际天数 / 标准45天）
  const scale = availableDays / STANDARD_DAYS;

  // 按比例计算每个节点的日期
  const calc = (standardDay: number): Date => {
    const actualDay = Math.round(standardDay * scale);
    return addDays(T0, actualDay);
  };

  // 不能晚于锚点（出运截止日）
  const cap = (d: Date): Date => d > A ? new Date(A) : d;

  // 船样特殊处理
  const shippingSample = shippingSampleRequired && shippingSampleDeadline
    ? parseDate(shippingSampleDeadline)!
    : calc(TIMELINE.shipping_sample_send);

  const result: Record<string, Date> = {
    po_confirmed:                  cap(calc(TIMELINE.po_confirmed)),
    finance_approval:              cap(calc(TIMELINE.finance_approval)),
    order_kickoff_meeting:         cap(calc(TIMELINE.order_kickoff_meeting)),
    production_order_upload:       cap(calc(TIMELINE.production_order_upload)),
    order_docs_bom_complete:       cap(calc(TIMELINE.order_docs_bom_complete)),
    bulk_materials_confirmed:      cap(calc(TIMELINE.bulk_materials_confirmed)),
    processing_fee_confirmed:      cap(calc(TIMELINE.processing_fee_confirmed)),
    factory_confirmed:             cap(calc(TIMELINE.factory_confirmed)),
    pre_production_sample_ready:   cap(calc(TIMELINE.pre_production_sample_ready)),
    pre_production_sample_sent:    cap(calc(TIMELINE.pre_production_sample_sent)),
    pre_production_sample_approved: cap(calc(TIMELINE.pre_production_sample_approved)),
    procurement_order_placed:      cap(calc(TIMELINE.procurement_order_placed)),
    materials_received_inspected:  cap(calc(TIMELINE.materials_received_inspected)),
    pre_production_meeting:        cap(calc(TIMELINE.pre_production_meeting)),
    production_kickoff:            cap(calc(TIMELINE.production_kickoff)),
    mid_qc_check:                  cap(calc(TIMELINE.mid_qc_check)),
    final_qc_check:                cap(calc(TIMELINE.final_qc_check)),
    packing_method_confirmed:      cap(calc(TIMELINE.packing_method_confirmed)),
    factory_completion:            cap(calc(TIMELINE.factory_completion)),
    inspection_release:            cap(calc(TIMELINE.inspection_release)),
    shipping_sample_send:          cap(shippingSample),
    booking_done:                  cap(calc(TIMELINE.booking_done)),
    customs_export:                cap(calc(TIMELINE.customs_export)),
    finance_shipment_approval:     cap(calc(TIMELINE.finance_shipment_approval)),
    shipment_execute:              cap(calc(TIMELINE.shipment_execute)),
    // FOB：默认出货前付款（ETD当天）| DDP：到港后10天（ETA+10）
    payment_received:              incoterm === 'FOB' ? new Date(rawAnchor) : addDays(rawAnchor, 10),
  };

  // ══════ 四重校验 ══════

  // 校验1：可用天数不能太短
  if (availableDays < 7) {
    throw new Error(`交期太近：下单日到${incoterm === 'DDP' ? '出运截止' : '交期'}仅 ${availableDays} 天（${incoterm === 'DDP' ? 'ETA减去25天海运' : 'ETD'}），最少需要 7 天`);
  }

  // 校验2：日期有效性
  for (const [key, date] of Object.entries(result)) {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      throw new Error(`排期异常：节点 ${key} 日期无效`);
    }
  }

  // 校验3：除收款外不晚于锚点
  for (const [key, date] of Object.entries(result)) {
    if (key === 'payment_received') continue;
    if (date.getTime() > A.getTime() + 86400000) {
      throw new Error(`排期异常：${key} 晚于${incoterm === 'DDP' ? '出运截止日' : '交期'}`);
    }
  }

  // 校验4：不早于下单日
  for (const [key, date] of Object.entries(result)) {
    if (key === 'payment_received') continue;
    if (date.getTime() < T0.getTime() - 86400000) {
      throw new Error(`排期异常：${key} 早于下单日`);
    }
  }

  return result;
}
