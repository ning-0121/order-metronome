/**
 * 订单经营状态引擎 — 统一计算层
 *
 * 所有经营判断逻辑集中在这里。UI 不写判断，只展示 engine 输出。
 * AI Skill 也调用这些函数。
 *
 * 每个计算函数返回 { value, level, explain } 三元组：
 *   - value: 计算结果
 *   - level: 'green' | 'yellow' | 'red' | 'gray'
 *   - explain: 人类可读的解释（为什么是这个结果）
 *
 * Admin override: 每个状态支持 override，override 后 explain 会标注。
 */

// ════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════

export type StatusLevel = 'green' | 'yellow' | 'red' | 'gray';

export interface StatusResult<T = string> {
  value: T;
  level: StatusLevel;
  explain: string;
  overridden?: boolean;
}

/** 经营引擎完整输出 — UI 直接消费 */
export interface OrderBusinessState {
  // 收款
  payment_status: StatusResult<'received' | 'partial' | 'pending' | 'overdue' | 'hold'>;
  overdue_payment_days: number;

  // 利润
  order_profit_status: StatusResult<'healthy' | 'low' | 'loss' | 'unknown'>;
  margin_pct: number | null;
  gross_profit_rmb: number | null;

  // 风险
  hidden_risk_level: StatusResult<'low' | 'medium' | 'high' | 'critical'>;
  risk_factors: string[];

  // 控制开关
  can_proceed_production: StatusResult<boolean>;
  can_ship: StatusResult<boolean>;

  // 确认链
  confirmation_completion_rate: number; // 0-100
  missing_confirmation_items: string[];
  confirmation_details: Array<{
    module: string;
    label: string;
    status: string;
    level: StatusLevel;
  }>;

  // 综合
  current_business_blocker: string | null; // 当前最紧迫的阻塞项
  estimated_delay_risk: StatusResult<'none' | 'low' | 'medium' | 'high'>;
}

/** 引擎输入 — 从 DB 查到的原始数据 */
export interface EngineInput {
  order: {
    id: string;
    order_no: string;
    quantity: number;
    incoterm: string;
    factory_date: string | null;
    is_new_customer: boolean;
    is_new_factory: boolean;
    special_tags: string[];
    lifecycle_status: string;
  };
  financials: {
    sale_total: number | null;
    exchange_rate: number;
    cost_total: number;
    cost_material: number;
    cost_cmt: number;
    cost_shipping: number;
    cost_other: number;
    gross_profit_rmb: number | null;
    margin_pct: number | null;
    deposit_amount: number | null;
    deposit_received: number;
    deposit_status: string;
    balance_amount: number | null;
    balance_received: number;
    balance_due_date: string | null;
    balance_status: string;
    payment_hold: boolean;
    allow_production: boolean;
    allow_shipment: boolean;
  } | null;
  confirmations: Array<{
    module: string;
    status: string;
    data: any;
    customer_confirmed: boolean;
  }>;
  milestones: Array<{
    step_key: string;
    status: string;
    due_at: string | null;
  }>;
}

// ════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════

const MIN_MARGIN_PCT = 8; // 公司最低毛利要求
const CONFIRMATION_LABELS: Record<string, string> = {
  fabric_color: '面料与颜色',
  size_breakdown: '尺码配比',
  logo_print: 'Logo/印花/绣花',
  packaging_label: '包装/唛头/标签',
};

// ════════════════════════════════════════════════
// 计算函数
// ════════════════════════════════════════════════

export function calculatePaymentStatus(input: EngineInput): StatusResult<'received' | 'partial' | 'pending' | 'overdue' | 'hold'> {
  const f = input.financials;
  if (!f) return { value: 'pending', level: 'gray', explain: '尚未录入经营数据' };

  if (f.payment_hold) {
    return { value: 'hold', level: 'red', explain: '付款问题暂停 — 财务已标记 payment_hold' };
  }

  // 没有录入金额 = 还没设置收款计划，不能当作"已收齐"
  const depositNotSet = !f.deposit_amount || f.deposit_amount <= 0;
  const balanceNotSet = !f.balance_amount || f.balance_amount <= 0;

  if (depositNotSet && balanceNotSet) {
    return { value: 'pending', level: 'yellow', explain: '收款计划未设置 — 请财务录入定金和尾款金额' };
  }

  const depositOk = f.deposit_status === 'received';
  const balanceOk = f.balance_status === 'received' || balanceNotSet;

  if (depositOk && balanceOk) {
    return { value: 'received', level: 'green', explain: '定金和尾款均已收齐' };
  }

  // 检查尾款逾期
  if (f.balance_due_date && f.balance_status !== 'received') {
    const dueDate = new Date(f.balance_due_date);
    const today = new Date();
    if (today > dueDate) {
      const overdueDays = Math.ceil((today.getTime() - dueDate.getTime()) / 86400000);
      return {
        value: 'overdue',
        level: 'red',
        explain: `尾款已逾期 ${overdueDays} 天（到期日 ${f.balance_due_date}）`,
      };
    }
  }

  if (depositOk && !balanceOk) {
    return { value: 'partial', level: 'yellow', explain: `定金已收，尾款待收 ¥${f.balance_amount?.toLocaleString() || '?'}` };
  }

  if (!depositOk) {
    return { value: 'pending', level: 'yellow', explain: `定金未收 ¥${f.deposit_amount?.toLocaleString() || '?'}` };
  }

  return { value: 'pending', level: 'gray', explain: '收款信息待补充' };
}

export function calculateOverduePaymentDays(input: EngineInput): number {
  const f = input.financials;
  if (!f?.balance_due_date || f.balance_status === 'received') return 0;
  const dueDate = new Date(f.balance_due_date);
  const today = new Date();
  return Math.max(0, Math.ceil((today.getTime() - dueDate.getTime()) / 86400000));
}

export function calculateProfitStatus(input: EngineInput): StatusResult<'healthy' | 'low' | 'loss' | 'unknown'> {
  const f = input.financials;
  if (!f || f.sale_total === null || f.sale_total === 0) {
    return { value: 'unknown', level: 'gray', explain: '未录入销售额，无法计算利润' };
  }

  const margin = f.margin_pct ?? 0;
  const profit = f.gross_profit_rmb ?? 0;

  if (margin < 0 || profit < 0) {
    return {
      value: 'loss',
      level: 'red',
      explain: `亏损！毛利 ¥${profit.toLocaleString()}，毛利率 ${margin}%`,
    };
  }
  if (margin < MIN_MARGIN_PCT) {
    return {
      value: 'low',
      level: 'yellow',
      explain: `毛利率 ${margin}% 低于公司最低要求 ${MIN_MARGIN_PCT}%（毛利 ¥${profit.toLocaleString()}）`,
    };
  }
  return {
    value: 'healthy',
    level: 'green',
    explain: `毛利率 ${margin}%，毛利 ¥${profit.toLocaleString()}`,
  };
}

export function calculateConfirmationCompletion(input: EngineInput): {
  rate: number;
  missing: string[];
  details: Array<{ module: string; label: string; status: string; level: StatusLevel }>;
} {
  const modules = ['fabric_color', 'size_breakdown', 'logo_print', 'packaging_label'];
  const details: Array<{ module: string; label: string; status: string; level: StatusLevel }> = [];
  const missing: string[] = [];
  let confirmed = 0;

  for (const mod of modules) {
    const conf = input.confirmations.find(c => c.module === mod);
    const status = conf?.status || 'not_started';
    let level: StatusLevel = 'gray';

    if (status === 'confirmed') {
      level = 'green';
      confirmed++;
    } else if (status === 'rejected' || status === 'reconfirm_required') {
      level = 'red';
      missing.push(CONFIRMATION_LABELS[mod] || mod);
    } else if (status === 'pending_customer' || status === 'pending_internal') {
      level = 'yellow';
      missing.push(CONFIRMATION_LABELS[mod] || mod);
    } else {
      level = 'gray';
      missing.push(CONFIRMATION_LABELS[mod] || mod);
    }

    details.push({ module: mod, label: CONFIRMATION_LABELS[mod] || mod, status, level });
  }

  const rate = modules.length > 0 ? Math.round((confirmed / modules.length) * 100) : 0;
  return { rate, missing, details };
}

export function calculateBusinessRisk(input: EngineInput): {
  level: StatusResult<'low' | 'medium' | 'high' | 'critical'>;
  factors: string[];
} {
  const factors: string[] = [];
  let score = 0;

  // 利润风险
  const profit = calculateProfitStatus(input);
  if (profit.value === 'loss') { factors.push('订单亏损'); score += 30; }
  else if (profit.value === 'low') { factors.push(`毛利率低于 ${MIN_MARGIN_PCT}%`); score += 15; }

  // 付款风险
  const payment = calculatePaymentStatus(input);
  if (payment.value === 'overdue') { factors.push('尾款逾期'); score += 25; }
  else if (payment.value === 'hold') { factors.push('付款暂停'); score += 30; }
  else if (payment.value === 'pending') { factors.push('定金未收'); score += 10; }

  // 确认链风险
  const conf = calculateConfirmationCompletion(input);
  if (conf.missing.length >= 3) { factors.push(`${conf.missing.length} 项确认缺失`); score += 20; }
  else if (conf.missing.length > 0) { factors.push(`${conf.missing.join('、')}未确认`); score += 10; }

  // 交期风险
  if (input.order.factory_date) {
    const remaining = Math.ceil((new Date(input.order.factory_date).getTime() - Date.now()) / 86400000);
    if (remaining < 0) { factors.push(`出厂已逾期 ${Math.abs(remaining)} 天`); score += 25; }
    else if (remaining <= 7) { factors.push(`距出厂仅 ${remaining} 天`); score += 15; }
  }

  // 特殊风险
  if (input.order.is_new_customer && input.order.is_new_factory) {
    factors.push('新客户+新工厂'); score += 10;
  }

  // 里程碑逾期
  const overdueMilestones = input.milestones.filter(m =>
    ['in_progress', '进行中'].includes(m.status) && m.due_at && new Date(m.due_at) < new Date()
  );
  if (overdueMilestones.length > 0) {
    factors.push(`${overdueMilestones.length} 个节点逾期`); score += overdueMilestones.length * 5;
  }

  let value: 'low' | 'medium' | 'high' | 'critical';
  let level: StatusLevel;
  if (score >= 50) { value = 'critical'; level = 'red'; }
  else if (score >= 30) { value = 'high'; level = 'red'; }
  else if (score >= 15) { value = 'medium'; level = 'yellow'; }
  else { value = 'low'; level = 'green'; }

  const explain = factors.length > 0
    ? `风险来源：${factors.join('；')}`
    : '当前无明显风险';

  return { level: { value, level, explain }, factors };
}

export function calculateCanProceedProduction(input: EngineInput): StatusResult<boolean> {
  const f = input.financials;
  const reasons: string[] = [];

  // Admin override
  if (f?.allow_production) {
    return { value: true, level: 'green', explain: '管理员已手动批准生产', overridden: true };
  }

  // 检查定金
  if (f?.deposit_amount && f.deposit_status !== 'received') {
    reasons.push('定金未收');
  }

  // 检查付款暂停
  if (f?.payment_hold) {
    reasons.push('付款问题暂停');
  }

  // 检查确认链
  const requiredForProduction = ['fabric_color', 'size_breakdown', 'logo_print'];
  for (const mod of requiredForProduction) {
    const conf = input.confirmations.find(c => c.module === mod);
    if (!conf || conf.status !== 'confirmed') {
      reasons.push(`${CONFIRMATION_LABELS[mod]}未确认`);
    }
  }

  // 检查利润
  const profit = calculateProfitStatus(input);
  if (profit.value === 'loss') {
    reasons.push('订单亏损需 CEO 审批');
  }

  if (reasons.length === 0) {
    return { value: true, level: 'green', explain: '所有前置条件满足，可以进入生产' };
  }

  return {
    value: false,
    level: 'red',
    explain: `不允许生产：${reasons.join('、')}`,
  };
}

export function calculateCanShip(input: EngineInput): StatusResult<boolean> {
  const f = input.financials;
  const reasons: string[] = [];

  // Admin override
  if (f?.allow_shipment) {
    return { value: true, level: 'green', explain: '管理员已手动批准出货', overridden: true };
  }

  // 检查尾款（除非信用放行）
  if (f?.balance_amount && f.balance_status !== 'received') {
    if (f.balance_status === 'overdue') {
      reasons.push('尾款已逾期');
    } else {
      reasons.push('尾款未收');
    }
  }

  // 检查包装确认
  const pkgConf = input.confirmations.find(c => c.module === 'packaging_label');
  if (!pkgConf || pkgConf.status !== 'confirmed') {
    reasons.push('包装/唛头未确认');
  }

  // 检查付款暂停
  if (f?.payment_hold) {
    reasons.push('付款问题暂停');
  }

  if (reasons.length === 0) {
    return { value: true, level: 'green', explain: '所有出货条件满足' };
  }

  return {
    value: false,
    level: 'red',
    explain: `不允许出货：${reasons.join('、')}`,
  };
}

export function calculateDelayRisk(input: EngineInput): StatusResult<'none' | 'low' | 'medium' | 'high'> {
  if (!input.order.factory_date) {
    return { value: 'none', level: 'gray', explain: '未设置出厂日期' };
  }

  const remaining = Math.ceil((new Date(input.order.factory_date).getTime() - Date.now()) / 86400000);

  if (remaining < 0) {
    return { value: 'high', level: 'red', explain: `已超出厂日期 ${Math.abs(remaining)} 天` };
  }

  // 确认链不完整 + 时间紧
  const conf = calculateConfirmationCompletion(input);
  if (conf.missing.length > 0 && remaining <= 14) {
    return {
      value: 'high',
      level: 'red',
      explain: `剩 ${remaining} 天出厂但 ${conf.missing.join('、')}未确认`,
    };
  }

  // 里程碑逾期
  const overdueCount = input.milestones.filter(m =>
    ['in_progress', '进行中'].includes(m.status) && m.due_at && new Date(m.due_at) < new Date()
  ).length;

  if (overdueCount >= 3) {
    return { value: 'high', level: 'red', explain: `${overdueCount} 个节点逾期，延期风险极高` };
  }
  if (overdueCount >= 1 && remaining <= 14) {
    return { value: 'medium', level: 'yellow', explain: `${overdueCount} 个节点逾期，剩 ${remaining} 天` };
  }
  if (remaining <= 7) {
    return { value: 'medium', level: 'yellow', explain: `距出厂仅 ${remaining} 天` };
  }

  return { value: 'none', level: 'green', explain: `距出厂 ${remaining} 天，进度正常` };
}

// ════════════════════════════════════════════════
// 主入口 — 一次计算所有状态
// ════════════════════════════════════════════════

export function computeOrderBusinessState(input: EngineInput): OrderBusinessState {
  const payment = calculatePaymentStatus(input);
  const overdueDays = calculateOverduePaymentDays(input);
  const profit = calculateProfitStatus(input);
  const conf = calculateConfirmationCompletion(input);
  const risk = calculateBusinessRisk(input);
  const canProduce = calculateCanProceedProduction(input);
  const canShip = calculateCanShip(input);
  const delayRisk = calculateDelayRisk(input);

  // 当前最紧迫的阻塞项
  let blocker: string | null = null;
  if (payment.value === 'hold') blocker = '付款问题暂停';
  else if (payment.value === 'overdue') blocker = `尾款逾期 ${overdueDays} 天`;
  else if (profit.value === 'loss') blocker = '订单亏损';
  else if (!canProduce.value && !canProduce.overridden) blocker = canProduce.explain.replace('不允许生产：', '');
  else if (conf.missing.length > 0) blocker = `${conf.missing[0]}未确认`;

  return {
    payment_status: payment,
    overdue_payment_days: overdueDays,
    order_profit_status: profit,
    margin_pct: input.financials?.margin_pct ?? null,
    gross_profit_rmb: input.financials?.gross_profit_rmb ?? null,
    hidden_risk_level: risk.level,
    risk_factors: risk.factors,
    can_proceed_production: canProduce,
    can_ship: canShip,
    confirmation_completion_rate: conf.rate,
    missing_confirmation_items: conf.missing,
    confirmation_details: conf.details,
    current_business_blocker: blocker,
    estimated_delay_risk: delayRisk,
  };
}
