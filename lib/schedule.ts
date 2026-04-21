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
 *   Day 31  (69%)   船样寄送（中查后立即寄，客户需5-7天确认）
 *   Day 33  (73%)   包装方式确认（预留4天包装时间）
 *   Day 36  (80%)   尾查（工厂完成前，问题可修复）
 *   Day 38  (84%)   工厂完成
 *   Day 40  (89%)   验货/放行（预留2天验货）
 *   Day 41  (91%)   订舱（放行后）
 *   Day 43  (96%)   报关安排出运 + 核准出运
 *   Day 44  (98%)   出运
 *   Day 45  (100%)  交期/出运截止
 *   Day 75          收款（交期+30）
 */

// DDP 海运时间（中国→美国西海岸约25天）
export const DDP_TRANSIT_DAYS = 25;

// 标准周期天数
const STANDARD_DAYS = 45;

/**
 * 中国法定节假日（2025-2027）
 * 每年年初更新。格式 'YYYY-MM-DD'
 * 包含：元旦、春节、清明、五一、端午、中秋、国庆
 */
const CHINA_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-01',                                                       // 元旦
  '2025-01-28','2025-01-29','2025-01-30','2025-01-31','2025-02-01',  // 春节
  '2025-02-02','2025-02-03','2025-02-04',
  '2025-04-04','2025-04-05','2025-04-06',                             // 清明
  '2025-05-01','2025-05-02','2025-05-03','2025-05-04','2025-05-05',  // 五一
  '2025-05-31','2025-06-01','2025-06-02',                             // 端午
  '2025-10-01','2025-10-02','2025-10-03','2025-10-04',               // 国庆+中秋
  '2025-10-05','2025-10-06','2025-10-07','2025-10-08',
  // 2026
  '2026-01-01','2026-01-02','2026-01-03',                             // 元旦
  '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20',  // 春节
  '2026-02-21','2026-02-22',
  '2026-04-05','2026-04-06','2026-04-07',                             // 清明
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',  // 五一
  '2026-06-19','2026-06-20','2026-06-21',                             // 端午
  '2026-09-25','2026-09-26','2026-09-27',                             // 中秋
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04',               // 国庆
  '2026-10-05','2026-10-06','2026-10-07',
  // 2027
  '2027-01-01','2027-01-02','2027-01-03',                             // 元旦
  '2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-02-10',  // 春节
  '2027-02-11','2027-02-12',
  '2027-04-05','2027-04-06','2027-04-07',                             // 清明
  '2027-05-01','2027-05-02','2027-05-03','2027-05-04','2027-05-05',  // 五一
  '2027-06-09','2027-06-10','2027-06-11',                             // 端午
  '2027-09-15','2027-09-16','2027-09-17',                             // 中秋
  '2027-10-01','2027-10-02','2027-10-03','2027-10-04',               // 国庆
  '2027-10-05','2027-10-06','2027-10-07',
]);

/**
 * 检查是否为非工作日（周日 + 中国法定节假日）
 * ⚠️ 北京时区处理：服务器 TZ 可能是 UTC，必须先 +8h 再用 UTC 方法读取。
 */
function isNonWorkday(d: Date): boolean {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  if (bj.getUTCDay() === 0) return true; // 周日
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return CHINA_HOLIDAYS.has(`${y}-${m}-${day}`);
}

/** 计算两个日期间的有效工作日数 */
function countWorkdays(from: Date, to: Date): number {
  let count = 0;
  const d = new Date(from);
  while (d <= to) {
    if (!isNonWorkday(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * 标准45天时间线（Day数 = 从下单日起的天数）
 *
 * ⚠️ 时间线设计原则（AI排期必读）：
 *
 * 1. 船样必须在中查后立即寄出（Day31），客户需要5-7天确认
 *    船样确认后才允许出货，不能等到验货放行后再寄
 *
 * 2. 包装方式确认（Day33）后需预留4-5天给工厂实际包装
 *    不能和工厂完成同一天
 *
 * 3. 工厂完成（Day38）后需预留2天给验货
 *    包含：预约第三方QC或客户验货 + 实际验货 + 出结果
 *
 * 4. 尾查（Day36）在工厂完成前进行，发现问题可修复
 *
 * 5. 验货放行（Day40）后才能订舱出货
 */
const TIMELINE = {
  // ── 阶段 1：订单评审（0-3 天）──
  po_confirmed:                  0,
  finance_approval:              1,
  order_kickoff_meeting:         2,   // 业务+CEO 双签会议
  production_order_upload:       3,   // 业务上传生产单 + 原辅料单

  // ── 阶段 2：双线并行预评估（5 天）──
  order_docs_bom_complete:       5,   // BOM 预评估（采购）— 必须在生产单上传后
  bulk_materials_confirmed:      5,   // 生产预评估（跟单）— 同步进行

  // ── 阶段 3：工厂匹配 + 加工费（6-8 天）──
  processing_fee_confirmed:      6,   // 加工费确认（财务）
  factory_confirmed:             8,   // 工厂匹配确认（跟单）

  // ── 阶段 3.5：头样（如需，插在工厂匹配后、产前样前）──
  dev_sample_making:             12,  // 头样制作（工厂确认后 4 天）
  dev_sample_sent:               13,  // 头样寄出
  dev_sample_customer_confirm:   18,  // 头样客户确认（寄出后 5 天）
  dev_sample_revision:           22,  // 二次样制作（头样被拒后 4 天）
  dev_sample_revision_sent:      23,  // 二次样寄出
  dev_sample_revision_confirm:   28,  // 二次样客户确认

  // ── 阶段 4：采购下单 + 产前样准备（9-19 天）──
  procurement_order_placed:      9,   // 采购下单 — 工厂确认后立即下大货料
  pre_production_sample_ready:   14,
  pre_production_sample_sent:    15,
  pre_production_sample_approved: 19,

  // ── 阶段 5：原料到货 + 产前会（20-21 天）──
  materials_received_inspected:  20,  // 原辅料到货验收
  pre_production_meeting:        21,  // 产前会（原料到齐 + 客户确认样品后）

  // ── 阶段 6：开裁 + 中查 ──
  production_kickoff:            22,  // 生产启动/开裁
  mid_qc_check:                  30,  // 跟单中查
  mid_qc_sales_check:            31,  // 业务中查（跟单后 1 天复核）

  // ── 阶段 7：包装方式确认 + 船样寄送 ──
  packing_method_confirmed:      32,  // 包装方式+资料确认（必须在船样和工厂完成前）
  shipping_sample_send:          33,  // 船样寄送（包装确认后才能寄）

  // ── 阶段 8：尾查 + 工厂完成 ──
  final_qc_check:                35,  // 跟单尾查 — 工厂完成前可修复
  final_qc_sales_check:          36,  // 业务尾查（跟单后 1 天复核）
  factory_completion:            38,  // 工厂完成（包装+尾查都通过后）
  leftover_collection:           39,  // 剩余物料回收（工厂完成后 1 天）
  finished_goods_warehouse:      39,  // 成品入库（与物料回收同期）
  inspection_release:            40,  // 预留2天：预约验货+验货+出结果
  booking_done:                  41,  // 放行后订舱
  customs_export:                43,
  finance_shipment_approval:     43,
  shipment_execute:              44,
  domestic_delivery:             43,
  // 打样专用节点（14天周期）
  sample_confirm:                0,
  sample_material:               2,
  sample_making:                 5,
  sample_qc:                     9,
  sample_sent:                   10,
  sample_customer_confirm:       12,
  sample_complete:               14,
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
  /** 样品确认预留天数（覆盖默认 19 天）— 针对慢确认客户 */
  sampleConfirmDaysOverride?: number | null;
  /** 跳过产前样（不计算这些节点的截止日期） */
  skipPreProductionSample?: boolean;
  /**
   * 客户节奏偏好（每个客户的自定义排期规则）
   * 形如 { "shipping_sample_send": { anchor: "factory_date", offset_days: -1 } }
   * 优先级高于 TIMELINE，覆盖对应节点的默认计算
   */
  customerScheduleOverrides?: Record<string, { anchor: 'factory_date' | 'order_date' | 'eta'; offset_days: number; note?: string }>;
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
    .filter(([, day]) => day > currentDay)  // 严格大于：不重算已完成的当前节点
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
    sampleConfirmDaysOverride,
    skipPreProductionSample = false,
  } = params;

  const T0 = parseDate(orderDate) ?? createdAt ?? new Date();
  const customerScheduleOverrides = params.customerScheduleOverrides || {};

  // 计算实际锚点
  // FOB/RMB: 锚点 = ETD 或 出厂日期（factory_date 通过 etd 参数传入）
  // DDP: 锚点 = ETA - 25天海运
  let anchorStr: string | null | undefined;
  if (incoterm === 'FOB') {
    anchorStr = etd; // etd 可能是真正的ETD，也可能是 factory_date（RMB/FOB统一传入）
  } else {
    anchorStr = eta || warehouseDueDate;
  }
  if (!anchorStr) throw new Error('缺少锚点日期：请填写出厂日期');

  const rawAnchor = new Date(anchorStr + 'T00:00:00+08:00');
  const etaDate = eta ? new Date(eta + 'T00:00:00+08:00') : null;

  // DDP 需要减去海运时间得到实际出运截止日
  const A = incoterm === 'DDP' ? addDays(rawAnchor, -DDP_TRANSIT_DAYS) : rawAnchor;

  /** 客户覆盖优先：若 step_key 有客户自定义节奏，直接按锚点+偏移计算 */
  const applyOverride = (stepKey: string, fallback: Date): Date => {
    const rule = customerScheduleOverrides[stepKey];
    if (!rule) return fallback;
    let anchor: Date;
    if (rule.anchor === 'order_date') anchor = T0;
    else if (rule.anchor === 'eta') anchor = etaDate || rawAnchor;
    else /* factory_date / ETD */ anchor = rawAnchor;
    return addDays(anchor, rule.offset_days);
  };

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

  // 样品确认天数覆盖：针对慢确认客户
  // 默认 pre_production_sample_approved 在 Day 19 (42%)
  // 如果客户需要更长确认时间，提前 N 天准备样品
  const sampleConfirmDays = sampleConfirmDaysOverride ?? TIMELINE.pre_production_sample_approved;

  const result: Record<string, Date> = {
    po_confirmed:                  cap(calc(TIMELINE.po_confirmed)),
    finance_approval:              cap(calc(TIMELINE.finance_approval)),
    order_kickoff_meeting:         cap(calc(TIMELINE.order_kickoff_meeting)),
    production_order_upload:       cap(calc(TIMELINE.production_order_upload)),
    order_docs_bom_complete:       cap(calc(TIMELINE.order_docs_bom_complete)),
    bulk_materials_confirmed:      cap(calc(TIMELINE.bulk_materials_confirmed)),
    processing_fee_confirmed:      cap(calc(TIMELINE.processing_fee_confirmed)),
    factory_confirmed:             cap(calc(TIMELINE.factory_confirmed)),
    // 头样/二次样（仅当 samplePhase 需要时，模板才包含这些节点）
    dev_sample_making:             cap(calc(TIMELINE.dev_sample_making)),
    dev_sample_sent:               cap(calc(TIMELINE.dev_sample_sent)),
    dev_sample_customer_confirm:   cap(calc(TIMELINE.dev_sample_customer_confirm)),
    dev_sample_revision:           cap(calc(TIMELINE.dev_sample_revision)),
    dev_sample_revision_sent:      cap(calc(TIMELINE.dev_sample_revision_sent)),
    dev_sample_revision_confirm:   cap(calc(TIMELINE.dev_sample_revision_confirm)),
    pre_production_sample_ready:   cap(applyOverride('pre_production_sample_ready', calc(TIMELINE.pre_production_sample_ready))),
    pre_production_sample_sent:    cap(applyOverride('pre_production_sample_sent', calc(TIMELINE.pre_production_sample_sent))),
    pre_production_sample_approved: cap(applyOverride('pre_production_sample_approved', calc(sampleConfirmDays))),
    procurement_order_placed:      cap(calc(TIMELINE.procurement_order_placed)),
    materials_received_inspected:  cap(calc(TIMELINE.materials_received_inspected)),
    pre_production_meeting:        cap(calc(TIMELINE.pre_production_meeting)),
    production_kickoff:            cap(calc(TIMELINE.production_kickoff)),
    mid_qc_check:                  cap(applyOverride('mid_qc_check', calc(TIMELINE.mid_qc_check))),
    mid_qc_sales_check:            cap(calc(TIMELINE.mid_qc_sales_check)),
    final_qc_check:                cap(applyOverride('final_qc_check', calc(TIMELINE.final_qc_check))),
    final_qc_sales_check:          cap(calc(TIMELINE.final_qc_sales_check)),
    packing_method_confirmed:      cap(applyOverride('packing_method_confirmed', calc(TIMELINE.packing_method_confirmed))),
    factory_completion:            cap(calc(TIMELINE.factory_completion)),
    leftover_collection:           cap(calc(TIMELINE.leftover_collection)),
    finished_goods_warehouse:      cap(calc(TIMELINE.finished_goods_warehouse)),
    inspection_release:            cap(applyOverride('inspection_release', calc(TIMELINE.inspection_release))),
    shipping_sample_send:          cap(applyOverride('shipping_sample_send', shippingSample)),
    booking_done:                  cap(calc(TIMELINE.booking_done)),
    customs_export:                cap(calc(TIMELINE.customs_export)),
    finance_shipment_approval:     cap(calc(TIMELINE.finance_shipment_approval)),
    shipment_execute:              cap(calc(TIMELINE.shipment_execute)),
    // 国内送仓节点（与报关同期）
    domestic_delivery:             cap(calc(TIMELINE.domestic_delivery)),
    // 打样专用节点
    sample_confirm:                cap(calc(TIMELINE.sample_confirm)),
    sample_material:               cap(calc(TIMELINE.sample_material)),
    sample_making:                 cap(calc(TIMELINE.sample_making)),
    sample_qc:                     cap(calc(TIMELINE.sample_qc)),
    sample_sent:                   cap(calc(TIMELINE.sample_sent)),
    sample_customer_confirm:       cap(calc(TIMELINE.sample_customer_confirm)),
    sample_complete:               cap(calc(TIMELINE.sample_complete)),
    // FOB：默认出货前付款（ETD当天）| DDP：到港后10天（ETA+10）
    payment_received:              applyOverride(
      'payment_received',
      incoterm === 'FOB' ? new Date(rawAnchor) : addDays(rawAnchor, 10),
    ),
  };

  // ══════ 四重校验 ══════

  // 校验1：可用天数不能太短（考虑节假日，实际工作日可能更少）
  const actualWorkdays = countWorkdays(T0, A);
  if (availableDays < 7 || actualWorkdays < 5) {
    throw new Error(`交期太近：下单日到${incoterm === 'DDP' ? '出运截止' : '交期'}仅 ${availableDays} 天（工作日 ${actualWorkdays} 天），最少需要 7 天`);
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

  // 校验4 + 防御性 clamp：任何节点（收款除外）都不能早于下单日
  // 历史 bug：ensureBusinessDay 时区问题曾把 T0 向后回退到节假日之前
  // 这里最后一道防线 — 不再 throw，直接 clamp 到 T0
  for (const [key, date] of Object.entries(result)) {
    if (key === 'payment_received') continue;
    if (date.getTime() < T0.getTime()) {
      console.warn(`[Schedule] clamp: ${key} (${date.toISOString()}) → T0 (${T0.toISOString()})`);
      result[key] = new Date(T0);
    }
  }

  // 校验5：关键时间间隔二次审核
  const gaps = [
    { from: 'packing_method_confirmed', to: 'factory_completion', minDays: 3, label: '包装确认→工厂完成需≥3天包装时间' },
    { from: 'factory_completion', to: 'inspection_release', minDays: 1, label: '工厂完成→验货放行需≥1天验货时间' },
    { from: 'shipping_sample_send', to: 'inspection_release', minDays: 5, label: '船样寄出→验货放行需≥5天（客户确认时间）' },
    { from: 'final_qc_check', to: 'factory_completion', minDays: 1, label: '尾查→工厂完成需≥1天修复时间' },
    { from: 'inspection_release', to: 'booking_done', minDays: 0, label: '验货放行→订舱不能倒序' },
  ];
  for (const gap of gaps) {
    const fromDate = result[gap.from];
    const toDate = result[gap.to];
    if (fromDate && toDate) {
      const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
      if (diffDays < gap.minDays) {
        console.warn(`[Schedule] 时间间隔警告：${gap.label}，实际仅 ${diffDays} 天`);
      }
    }
  }

  return result;
}
