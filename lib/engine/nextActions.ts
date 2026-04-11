/**
 * Next Action 映射 — 每张卡片的引导动作
 *
 * 不是通用提示，是具体的 "下一步该做什么" + CTA 按钮
 */

import type { OrderBusinessState } from './orderBusinessEngine';

export interface NextAction {
  label: string;      // CTA 按钮文案
  explain: string;    // hover tooltip
  priority: 'high' | 'medium' | 'low';
  href?: string;      // 跳转链接（相对于订单详情页）
  tab?: string;       // 切换到哪个 tab
}

export function getProfitNextAction(state: OrderBusinessState, orderId: string): NextAction | null {
  if (state.order_profit_status.value === 'unknown') {
    return {
      label: '录入经营数据',
      explain: '请财务录入销售单价和成本，系统自动计算利润',
      priority: 'high',
      tab: 'cost_control',
    };
  }
  if (state.order_profit_status.value === 'loss') {
    return {
      label: '复核报价',
      explain: '此单亏损，建议复核报价或与客户协商调价',
      priority: 'high',
      tab: 'cost_control',
    };
  }
  if (state.order_profit_status.value === 'low') {
    return {
      label: '优化成本',
      explain: '毛利率偏低，检查是否有降本空间',
      priority: 'medium',
      tab: 'cost_control',
    };
  }
  return null;
}

export function getPaymentNextAction(state: OrderBusinessState, orderId: string): NextAction | null {
  if (state.payment_status.value === 'hold') {
    return {
      label: '处理付款问题',
      explain: '付款已暂停，请联系财务解决',
      priority: 'high',
    };
  }
  if (state.payment_status.value === 'overdue') {
    return {
      label: '催收尾款',
      explain: `尾款已逾期 ${state.overdue_payment_days} 天，请立即催款`,
      priority: 'high',
    };
  }
  if (state.payment_status.value === 'pending') {
    return {
      label: '跟进定金',
      explain: '定金未收，请跟进客户付款',
      priority: 'high',
    };
  }
  if (!state.can_proceed_production.value && !state.can_proceed_production.overridden) {
    return {
      label: '申请生产放行',
      explain: state.can_proceed_production.explain,
      priority: 'high',
    };
  }
  return null;
}

export function getRiskNextAction(state: OrderBusinessState, orderId: string): NextAction | null {
  if (state.current_business_blocker) {
    return {
      label: '处理卡点',
      explain: state.current_business_blocker,
      priority: 'high',
    };
  }
  if (state.estimated_delay_risk.value === 'high') {
    return {
      label: '预防延期',
      explain: state.estimated_delay_risk.explain,
      priority: 'high',
    };
  }
  if (state.hidden_risk_level.value === 'high' || state.hidden_risk_level.value === 'critical') {
    return {
      label: '审查风险',
      explain: state.hidden_risk_level.explain,
      priority: 'high',
    };
  }
  return null;
}

export function getConfirmationNextAction(state: OrderBusinessState, orderId: string): NextAction | null {
  if (state.missing_confirmation_items.length === 0) return null;

  const first = state.missing_confirmation_items[0];
  const actionMap: Record<string, { label: string; explain: string }> = {
    '面料与颜色': { label: '确认面料颜色', explain: '请上传色卡/面料确认件，提交给客户确认' },
    '尺码配比': { label: '确认尺码配比', explain: '请确认各尺码数量分配，避免裁片错误' },
    'Logo/印花/绣花': { label: '确认 Logo 文件', explain: '请上传最终矢量文件并获取客户确认' },
    '包装/唛头/标签': { label: '确认包装要求', explain: '请确认唛头/条码/吊牌/洗标内容' },
  };

  const action = actionMap[first] || { label: `确认${first}`, explain: `${first}未完成确认` };
  return { ...action, priority: 'high' };
}

/**
 * 空状态文案
 */
export const EMPTY_STATE_TEXT = {
  profit: { title: '待录入', desc: '财务录入销售额和成本后自动计算' },
  payment: { title: '待设置', desc: '请设置定金比例和尾款到期日' },
  risk: { title: '评估中', desc: '录入经营数据后自动评估风险' },
  confirmation: { title: '待发起', desc: '请逐项填写并提交客户确认' },
};
