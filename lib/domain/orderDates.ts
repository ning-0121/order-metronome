/**
 * Order Date Chain Validation — 订单日期链约束 SSOT
 *
 * 外贸标准物理约束：
 *   order_date ≤ factory_date ≤ etd ≤ warehouse_due_date (ETA) ≤ cancel_date
 *
 * 含义：
 *   order_date          — 下单日（业务接 PO）
 *   factory_date        — 工厂完成日（出厂日，货从工厂离开）
 *   etd                 — Estimated Time of Departure（船/飞从原产港出发）
 *   warehouse_due_date  — Estimated Time of Arrival / 客户要求送达（UI 显示为 ETA）
 *   cancel_date         — 客户取消日（PO 规定的最晚交货日）
 *
 * 为什么这些必须严格升序：
 *   - 货物物理流转：先做完 → 出厂 → 装船 → 海运 → 到港 / 到仓
 *   - 任何一对逆序都意味着数据填错（如 ETA 早于 ETD 物理不可能）
 *
 * 历史 bug：
 *   2026-05-18 截图显示 ETA(2026-04-20) 早于 ETD(2026-05-30) 35 天，
 *   根因是延期审批通过时不走校验（delays.ts approveDelayRequestCore）。
 *   现在所有日期变更路径统一调用本 helper。
 */

export interface OrderDates {
  order_date?: string | null;
  factory_date?: string | null;
  etd?: string | null;
  warehouse_due_date?: string | null;  // 显示为 ETA
  eta?: string | null;                  // 独立字段（早期数据可能也用此字段）
  cancel_date?: string | null;
}

export interface DateChainViolation {
  /** 哪一对日期出问题 */
  pair: string;
  /** 详细错误信息（直接展示给业务）*/
  message: string;
  /** 违反类型 */
  code: 'reverse_order' | 'invalid_format';
}

/**
 * 校验日期链
 * @returns 违规列表，空数组表示通过
 *
 * 校验规则：
 *   严格升序：order_date ≤ factory_date ≤ etd ≤ ETA ≤ cancel_date
 *   ETA 取 warehouse_due_date，若 null 则 fallback 到 eta 字段
 *   任意字段为空时跳过该对的校验（部分字段允许空，按业务规则）
 */
export function validateOrderDateChain(input: OrderDates): DateChainViolation[] {
  const violations: DateChainViolation[] = [];

  // 工具：把日期字符串转 Date 对象，无效返回 null
  const parse = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const order_date_d = parse(input.order_date);
  const factory_date_d = parse(input.factory_date);
  const etd_d = parse(input.etd);
  // ETA 优先用 warehouse_due_date（UI 显示的就是它），fallback 到 eta
  const eta_raw = input.warehouse_due_date || input.eta;
  const eta_d = parse(eta_raw);
  const cancel_date_d = parse(input.cancel_date);

  // 1. order_date ≤ factory_date
  if (order_date_d && factory_date_d && order_date_d > factory_date_d) {
    violations.push({
      pair: 'order_date → factory_date',
      message: `出厂日期（${input.factory_date}）不能早于下单日期（${input.order_date}）`,
      code: 'reverse_order',
    });
  }

  // 2. factory_date ≤ etd
  if (factory_date_d && etd_d && factory_date_d > etd_d) {
    violations.push({
      pair: 'factory_date → etd',
      message: `ETD（${input.etd}）不能早于出厂日期（${input.factory_date}）`,
      code: 'reverse_order',
    });
  }

  // 3. etd ≤ ETA（warehouse_due_date or eta）
  if (etd_d && eta_d && etd_d > eta_d) {
    violations.push({
      pair: 'etd → eta',
      message: `ETA（${eta_raw}）不能早于 ETD（${input.etd}）— 货物先出港才能到港`,
      code: 'reverse_order',
    });
  }

  // 4. ETA ≤ cancel_date（客户允许的最晚交货日）
  if (eta_d && cancel_date_d && eta_d > cancel_date_d) {
    violations.push({
      pair: 'eta → cancel_date',
      message: `Cancel Date（${input.cancel_date}）不能早于 ETA（${eta_raw}）`,
      code: 'reverse_order',
    });
  }

  // 5. factory_date ≤ cancel_date（兜底：即使 ETD/ETA 缺失也得检查）
  if (factory_date_d && cancel_date_d && factory_date_d > cancel_date_d) {
    violations.push({
      pair: 'factory_date → cancel_date',
      message: `Cancel Date（${input.cancel_date}）不能早于出厂日期（${input.factory_date}）`,
      code: 'reverse_order',
    });
  }

  return violations;
}

/**
 * 单字段校验：当只更新某一个日期时，传入当前完整日期 + 新值，校验是否破坏链
 * 用法：approveDelayRequest 路径上，只改 etd，调用此 helper 传入新 etd + 数据库现有其他日期。
 */
export function validateDateChainWithUpdate(
  current: OrderDates,
  update: Partial<OrderDates>,
): DateChainViolation[] {
  const merged: OrderDates = { ...current, ...update };
  return validateOrderDateChain(merged);
}

/**
 * 把违规列表格式化成单行错误消息（给 action return error 用）
 */
export function formatDateChainErrors(violations: DateChainViolation[]): string {
  if (violations.length === 0) return '';
  if (violations.length === 1) return violations[0].message;
  return `订单日期链不合理（共 ${violations.length} 项）：\n` +
    violations.map((v, i) => `  ${i + 1}. ${v.message}`).join('\n');
}
