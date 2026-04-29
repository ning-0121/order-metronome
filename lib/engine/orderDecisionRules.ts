// ============================================================
// Order Decision Engine — Rules Layer
// 职责：纯函数规则引擎，输入 OrderDecisionContext，输出 RulesPrediction
// 严格纪律：
//   1. 纯函数，无 IO，无 await，无 supabase，无 AI
//   2. 不写任何表、不调任何 server action
//   3. 不动主链路、不真阻塞 workflow
//   4. 8 条用户确认的规则（Rule 6 拆 4 子规则 → 共 11 个 RuleFlag id）
//   5. Rule 7 仅 CAUTION，不出 STOP（V1 简化）
//   6. whetherAiNeeded 永远 false（Phase 1.0 不接 AI）
// ============================================================

import type {
  OrderDecisionContext,
  RulesPrediction,
  RuleFlag,
  DecisionValue,
} from '@/lib/types/decision';

// ────────────────────────────────────────────────────────────
// 阈值常量（业务可调优，不要散落到规则函数体）
// ────────────────────────────────────────────────────────────

/** Rule 1: 三单任意两价偏差超过此比例(%) 即触发 STOP */
const PRICE_DIFF_THRESHOLD_PCT = 1.0;

/** Rule 2: 毛利率低于此值(%) 触发 STOP */
const MARGIN_STOP = 5;

/** Rule 3: 毛利率低于此值(%) 触发 CAUTION（未触发 Rule 2 时） */
const MARGIN_CAUTION = 8;

/** Rule 6: 距出厂 ≤ 此天数，关键确认缺失 → STOP */
const LEAD_DAYS_CRITICAL = 7;

/** Rule 6: 距出厂 ≤ 此天数（但 > CRITICAL），关键确认缺失 → CAUTION；超过则不报警 */
const LEAD_DAYS_WARNING = 21;

/** Rule 7: 工厂历史平均延期 ≥ 此天数 → 触发 CAUTION */
const FACTORY_AVG_DELAY_THRESHOLD = 5;

/** Rule 7: 距出厂 < 此天数 + 新工厂 → 触发 CAUTION（数据稀缺信号） */
const LEAD_DAYS_FACTORY_RISK = 30;

/** Rule 5: 距出厂/etd ≤ 此天数视为"出货临近" */
const SHIPMENT_BALANCE_LEAD_DAYS = 14;

/** Rule 8: 定金占订单总额低于此 % 视为"预付款不足" */
const DEPOSIT_PCT_THRESHOLD = 30;

/** Rule 8: 这些 special_tag 视为"复杂工艺" */
const COMPLEX_TAGS = ['plus_size', 'high_stretch', 'complex_print', 'custom_packaging'];

/** lifecycle_status 终态集合（Rule 4/5 跳过） */
const TERMINAL_LIFECYCLE = new Set([
  '草稿', 'draft',
  '已完成', 'completed',
  '待复盘', '已复盘',
  '已取消', 'cancelled',
]);

// ============================================================
// 公开 API
// ============================================================

export function evaluateOrderDecisionRules(ctx: OrderDecisionContext): RulesPrediction {
  const flags: RuleFlag[] = [];

  // 业务/财务/可行性 三类规则按顺序求值
  pushIf(flags, ruleThreeDocPriceMismatch(ctx));
  pushIf(flags, ruleMarginBelow5(ctx));
  pushIf(flags, ruleMargin5to8(ctx));
  pushIf(flags, ruleDepositNotReceivedPreProduction(ctx));
  pushIf(flags, ruleBalanceNotReceivedPreShipment(ctx));
  pushIf(flags, ruleFabricColorMissing(ctx));
  pushIf(flags, ruleSizeBreakdownMissing(ctx));
  pushIf(flags, ruleLogoArtworkMissing(ctx));
  pushIf(flags, rulePackagingLabelMissing(ctx));
  pushIf(flags, ruleFactoryCapacityRisk(ctx));
  pushIf(flags, ruleNewCustomerComplexNoDeposit(ctx));

  return {
    flags,
    whetherAiNeeded: false,        // Phase 1.0 永远 false
    aiReason: null,
    preliminaryDecision: aggregateDecision(flags),
  };
}

// ============================================================
// 公共 helper
// ============================================================

function pushIf(arr: RuleFlag[], f: RuleFlag | null): void {
  if (f) arr.push(f);
}

function aggregateDecision(flags: RuleFlag[]): DecisionValue {
  if (flags.some(f => f.decision === 'STOP')) return 'STOP';
  if (flags.some(f => f.decision === 'CAUTION')) return 'CAUTION';
  return 'PROCEED';
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

function pctDiff(a: number, b: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b));
  if (m === 0) return 0;
  return (Math.abs(a - b) / m) * 100;
}

function findConfirmation(
  confirmations: Record<string, any>[],
  moduleName: string,
): Record<string, any> | null {
  return confirmations.find(c => c.module === moduleName) ?? null;
}

function isConfirmed(confirmation: Record<string, any> | null): boolean {
  return confirmation?.status === 'confirmed';
}

// ============================================================
// Rule 1：三单价格一致性
// ============================================================

function ruleThreeDocPriceMismatch(ctx: OrderDecisionContext): RuleFlag | null {
  const orderPrice = num(ctx.order.unit_price);
  const incoterm = String(ctx.order.incoterm ?? '');
  const baselinePrice = incoterm === 'DDP'
    ? num(ctx.costBaseline?.ddp_price)
    : num(ctx.costBaseline?.fob_price);
  const financialsPrice = num(ctx.financials?.sale_price_per_piece);

  const prices: Array<{ source: string; value: number }> = [];
  if (orderPrice !== null) prices.push({ source: '订单 PO 单价', value: orderPrice });
  if (baselinePrice !== null) {
    prices.push({ source: `成本核算单 ${incoterm || 'FOB'} 价`, value: baselinePrice });
  }
  if (financialsPrice !== null) {
    prices.push({ source: '财务记录售价', value: financialsPrice });
  }

  // 至少需要 2 个价格才能比对
  if (prices.length < 2) return null;

  let worst: { a: { source: string; value: number }; b: { source: string; value: number }; diff: number } | null = null;
  for (let i = 0; i < prices.length; i++) {
    for (let j = i + 1; j < prices.length; j++) {
      const diff = pctDiff(prices[i].value, prices[j].value);
      if (!worst || diff > worst.diff) worst = { a: prices[i], b: prices[j], diff };
    }
  }
  if (!worst || worst.diff <= PRICE_DIFF_THRESHOLD_PCT) return null;

  return {
    id: 'three_doc_price_mismatch',
    category: 'financial',
    severity: 'high',
    decision: 'STOP',
    message: `三单价格不一致：${worst.a.source} ${worst.a.value} vs ${worst.b.source} ${worst.b.value}（偏差 ${worst.diff.toFixed(2)}%）`,
    evidence: `pctDiff(${worst.a.source}=${worst.a.value}, ${worst.b.source}=${worst.b.value}) = ${worst.diff.toFixed(2)}% > 阈值 ${PRICE_DIFF_THRESHOLD_PCT}%`,
    nextAction: '业务回去确认三方文档对齐（PO / 内部成本核算 / 客户报价单），财务签字后重传 → 重新评审自动解除 STOP',
  };
}

// ============================================================
// Rule 2：毛利率 < 5% → STOP
// ============================================================

function ruleMarginBelow5(ctx: OrderDecisionContext): RuleFlag | null {
  const margin = num(ctx.financials?.margin_pct);
  if (margin === null || margin >= MARGIN_STOP) return null;

  return {
    id: 'margin_below_5pct',
    category: 'financial',
    severity: 'high',
    decision: 'STOP',
    message: `预测毛利率 ${margin.toFixed(1)}% 低于 5% 安全线`,
    evidence: `order_financials.margin_pct = ${margin}（< ${MARGIN_STOP}%）`,
    nextAction: 'CEO 亲签 + 战略理由（新客户铺路 / 清空尾料 / 抢占市场）才能 override；override 后整单转特殊流程，采购单笔超 ¥500 都要审批',
  };
}

// ============================================================
// Rule 3：毛利率 5-8% → CAUTION
// ============================================================

function ruleMargin5to8(ctx: OrderDecisionContext): RuleFlag | null {
  const margin = num(ctx.financials?.margin_pct);
  if (margin === null || margin < MARGIN_STOP || margin >= MARGIN_CAUTION) return null;

  return {
    id: 'margin_5_to_8pct',
    category: 'financial',
    severity: 'medium',
    decision: 'CAUTION',
    message: `预测毛利率 ${margin.toFixed(1)}% 处于 5-8% 警戒区`,
    evidence: `order_financials.margin_pct = ${margin}（${MARGIN_STOP}% ≤ x < ${MARGIN_CAUTION}%）`,
    nextAction: 'admin 主动 acknowledge "已关注成本"，后续采购 / 加工费 / 物流任一项超支 5% 自动告警 CEO',
  };
}

// ============================================================
// Rule 4：定金未收但准备生产 → STOP
// ============================================================

function ruleDepositNotReceivedPreProduction(ctx: OrderDecisionContext): RuleFlag | null {
  const lifecycle = String(ctx.order.lifecycle_status ?? '');
  if (TERMINAL_LIFECYCLE.has(lifecycle)) return null;

  const depositAmount = num(ctx.financials?.deposit_amount);
  const depositStatus = String(ctx.financials?.deposit_status ?? '');

  // 定金未设置或已收 → 跳过
  if (depositAmount === null || depositAmount <= 0) return null;
  if (depositStatus === 'received') return null;

  // "准备生产"信号：已建采购明细 / cost_baseline / lifecycle 已是执行中
  const productionSignals: string[] = [];
  if (ctx.procurementItems.length > 0) {
    productionSignals.push(`已建 ${ctx.procurementItems.length} 条采购明细`);
  }
  if (ctx.costBaseline) productionSignals.push('已建成本基线');
  if (lifecycle === '执行中' || lifecycle === 'running') {
    productionSignals.push(`lifecycle=${lifecycle}`);
  }
  if (productionSignals.length === 0) return null;

  return {
    id: 'deposit_not_received_pre_production',
    category: 'financial',
    severity: 'high',
    decision: 'STOP',
    message: `定金 ¥${depositAmount} 未收（status=${depositStatus || 'unset'}），但订单已进入生产准备阶段`,
    evidence: `order_financials.deposit_status='${depositStatus}'; 准备生产信号：${productionSignals.join('；')}`,
    blockedMilestone: 'production_kickoff',
    nextAction: 'CEO 亲签 + 标注"接受信用风险，预计敞口 ¥XXX"才能 override；override 自动写入该客户 customer_memory，未来订单自动提醒',
  };
}

// ============================================================
// Rule 5：尾款未收但准备出货 → STOP
// ============================================================

function ruleBalanceNotReceivedPreShipment(ctx: OrderDecisionContext): RuleFlag | null {
  const lifecycle = String(ctx.order.lifecycle_status ?? '');
  if (TERMINAL_LIFECYCLE.has(lifecycle)) return null;

  const balanceAmount = num(ctx.financials?.balance_amount);
  const balanceStatus = String(ctx.financials?.balance_status ?? '');
  if (balanceAmount === null || balanceAmount <= 0) return null;
  if (balanceStatus === 'received') return null;

  // "出货临近"信号：距 factory_date 或 etd 已 ≤ 14 天
  const factoryDays = daysUntil(ctx.order.factory_date);
  const etdDays = daysUntil(ctx.order.etd);
  const candidateDays: number[] = [];
  if (factoryDays !== null) candidateDays.push(factoryDays);
  if (etdDays !== null) candidateDays.push(etdDays);
  if (candidateDays.length === 0) return null;

  const closest = Math.min(...candidateDays);
  if (closest > SHIPMENT_BALANCE_LEAD_DAYS) return null;

  return {
    id: 'balance_not_received_pre_shipment',
    category: 'financial',
    severity: 'high',
    decision: 'STOP',
    message: `尾款 ¥${balanceAmount} 未收（status=${balanceStatus || 'unset'}），但距出货仅 ${closest} 天`,
    evidence: `order_financials.balance_status='${balanceStatus}'; daysToShipment=${closest} ≤ ${SHIPMENT_BALANCE_LEAD_DAYS}`,
    blockedMilestone: 'shipment_execute',
    nextAction: 'finance + admin 双签，必须注明具体依据（例："已收 70%+ 货值" / "客户连续 6 单准时全款" / "已开 LC 信用证"）',
  };
}

// ============================================================
// Rule 6.x：关键确认缺失（4 个子规则共用模板）
// ============================================================

function buildConfirmationMissingFlag(
  ctx: OrderDecisionContext,
  ruleId:
    | 'fabric_color_missing'
    | 'size_breakdown_missing'
    | 'logo_artwork_missing'
    | 'packaging_label_missing',
  moduleName: string,
  displayName: string,
  blockedMilestone: string,
  whoToFix: string,
): RuleFlag | null {
  const conf = findConfirmation(ctx.confirmations, moduleName);
  if (isConfirmed(conf)) return null;

  const days = daysUntil(ctx.order.factory_date);
  if (days === null) return null;          // 没出厂日不能判定急迫度
  if (days > LEAD_DAYS_WARNING) return null; // > 21 天不报警（还早）

  const isCritical = days <= LEAD_DAYS_CRITICAL;

  return {
    id: ruleId,
    category: 'feasibility',
    severity: isCritical ? 'high' : 'medium',
    decision: isCritical ? 'STOP' : 'CAUTION',
    message: `${displayName}未确认，距出厂仅 ${days} 天`,
    evidence: `order_confirmations.${moduleName}.status='${conf?.status ?? 'absent'}'; daysToFactory=${days}; threshold=STOP≤${LEAD_DAYS_CRITICAL}d / CAUTION≤${LEAD_DAYS_WARNING}d`,
    blockedMilestone,
    nextAction: isCritical
      ? `STOP — 不允许 override。立即找 ${whoToFix}，必须拿到书面确认（邮件 / 微信截图 / 签字 PDF）才能继续`
      : `CAUTION — 找 ${whoToFix} 确认，并把客户口头/微信 commit 截图存档作为合规证据`,
  };
}

// Rule 6.1
function ruleFabricColorMissing(ctx: OrderDecisionContext): RuleFlag | null {
  return buildConfirmationMissingFlag(
    ctx,
    'fabric_color_missing',
    'fabric_color',
    '面料颜色',
    'production_kickoff',
    '客户确认面料色号（pantone / 物理色卡）',
  );
}

// Rule 6.2
function ruleSizeBreakdownMissing(ctx: OrderDecisionContext): RuleFlag | null {
  return buildConfirmationMissingFlag(
    ctx,
    'size_breakdown_missing',
    'size_breakdown',
    '尺码配比',
    'production_order_upload',
    '客户确认尺码配比（excel / 邮件回执）',
  );
}

// Rule 6.3
function ruleLogoArtworkMissing(ctx: OrderDecisionContext): RuleFlag | null {
  return buildConfirmationMissingFlag(
    ctx,
    'logo_artwork_missing',
    'logo_print',
    '印花 / Logo 稿件',
    'procurement_order_placed',
    '客户确认印花稿件（AI 矢量 / 高清 PNG）',
  );
}

// Rule 6.4
function rulePackagingLabelMissing(ctx: OrderDecisionContext): RuleFlag | null {
  return buildConfirmationMissingFlag(
    ctx,
    'packaging_label_missing',
    'packaging_label',
    '包装方式 / 唛头',
    'booking_done',
    '客户确认包装方式 + 唛头版式',
  );
}

// ============================================================
// Rule 7：工厂交期 / 产能风险 — V1 仅 CAUTION
// ============================================================

function ruleFactoryCapacityRisk(ctx: OrderDecisionContext): RuleFlag | null {
  const days = daysUntil(ctx.order.factory_date);
  if (days === null) return null; // 没出厂日不评

  const factoryName = String(
    ctx.factoryProfile?.name
      ?? ctx.factoryProfile?.factory_name
      ?? ctx.order.factory_name
      ?? '工厂',
  );

  const concerns: string[] = [];

  // 信号 1：工厂表里有历史平均延期 ≥ 阈值
  const avgDelay = num(ctx.factoryProfile?.avg_delay_days);
  if (avgDelay !== null && avgDelay >= FACTORY_AVG_DELAY_THRESHOLD) {
    concerns.push(`该工厂历史平均延期 ${avgDelay.toFixed(1)} 天`);
  }

  // 信号 2：新工厂 + 距出厂 < 30 天（数据稀缺）
  const isNewFactory = ctx.order.is_new_factory === true;
  if (isNewFactory && days < LEAD_DAYS_FACTORY_RISK) {
    concerns.push(`新工厂 + 距出厂 ${days} 天，缺乏历史数据`);
  }

  // 信号 3：同客户近期单中有延期 → 派生平均延期
  const delayedSimilar = ctx.similarOrders.filter(
    s => s.delayDays !== null && (s.delayDays as number) > 0,
  );
  if (delayedSimilar.length >= 2) {
    const avgSimDelay =
      delayedSimilar.reduce((acc, s) => acc + (s.delayDays as number), 0) /
      delayedSimilar.length;
    if (avgSimDelay > FACTORY_AVG_DELAY_THRESHOLD) {
      concerns.push(
        `同客户近 ${delayedSimilar.length} 单平均延期 ${avgSimDelay.toFixed(1)} 天`,
      );
    }
  }

  if (concerns.length === 0) return null;

  return {
    id: 'factory_capacity_risk',
    category: 'feasibility',
    severity: 'medium',
    decision: 'CAUTION',
    message: `工厂 ${factoryName} 产能/交期存在 ${concerns.length} 项风险信号`,
    evidence: concerns.join('；'),
    nextAction:
      '建议：① 中查频率从 7 天改 3 天 ② 要求工厂提交未来 30 天排产表 ③ 预订备用工厂保留产能 ④ 出厂前 14/7/3 天三次主动核对工序',
  };
}

// ============================================================
// Rule 8：新客户 + 复杂工艺 + 预付款不足 → STOP
// ============================================================

function ruleNewCustomerComplexNoDeposit(ctx: OrderDecisionContext): RuleFlag | null {
  const isNew =
    ctx.order.is_new_customer === true
    || ctx.customerProfile?.customer_core?.is_new_customer === true;
  if (!isNew) return null;

  const tags: string[] = Array.isArray(ctx.order.special_tags)
    ? (ctx.order.special_tags as string[])
    : [];
  const matchingComplex = tags.filter(t => COMPLEX_TAGS.includes(t));
  if (matchingComplex.length === 0) return null;

  // 计算 deposit 占比
  const depositAmount = num(ctx.financials?.deposit_amount);
  const saleTotal = num(ctx.financials?.sale_total);
  let depositPct: number;
  if (depositAmount !== null && saleTotal !== null && saleTotal > 0) {
    depositPct = (depositAmount / saleTotal) * 100;
  } else {
    // 没设定金 = 视为 0%
    depositPct = 0;
  }

  if (depositPct >= DEPOSIT_PCT_THRESHOLD) return null;

  return {
    id: 'new_customer_complex_no_deposit',
    category: 'business',
    severity: 'high',
    decision: 'STOP',
    message: `新客户首单 + 复杂工艺(${matchingComplex.join(', ')}) + 定金 ${depositPct.toFixed(0)}% 不足`,
    evidence: `is_new_customer=true; complex_tags=[${matchingComplex.join(',')}]; depositPct=${depositPct.toFixed(1)}% < ${DEPOSIT_PCT_THRESHOLD}%`,
    nextAction:
      'CEO 亲签 + 战略理由 + 明确止损标准（如"打样不超 3 次，超过则停项目"），写入 decision_feedback + order_logs',
  };
}
