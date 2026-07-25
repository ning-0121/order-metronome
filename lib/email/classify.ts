/**
 * 邮件规则分类器(Phase 1 归纳层 Tier 0,2026-07-25 CEO 批)。
 * 纯逻辑、零 token:关键词/正则把邮件劈进桶,给 Haiku 批量摘要(Tier 1)做前置减负。
 * 客户是外贸(中英文混发),关键词双语覆盖。
 */

export type MailCategory = '投诉' | '交期' | '样品' | 'PO' | '报价' | '物流' | '其他' | '噪音';

export const MAIL_CATEGORIES: MailCategory[] = ['投诉', '交期', '样品', 'PO', '报价', '物流', '其他', '噪音'];

/** 面向业务执行的类别标签(展示用)。 */
export const CATEGORY_LABEL: Record<MailCategory, string> = {
  投诉: '投诉/索赔', 交期: '交期/船期', 样品: '样品/打样', PO: 'PO/订单',
  报价: '报价/价格', 物流: '订舱/物流', 其他: '其他', 噪音: '噪音(自动/退信)',
};

// 噪音:自动回复/缺席/退信/订阅 —— 直接判噪音,不喂 AI。
const NOISE = [
  'out of office', 'auto-reply', 'auto reply', 'automatic reply', 'autoreply',
  'do not reply', 'no-reply', 'noreply', 'mailer-daemon', 'undeliverable', 'delivery status notification',
  'unsubscribe', 'newsletter', 'read receipt',
  '自动回复', '自动回覆', '假期', '休假', '退信', '无法投递', '退订', '订阅',
];

// 类别关键词(按判定优先级从高到低排:投诉 > 交期 > 样品 > PO > 报价 > 物流)。
const RULES: { cat: MailCategory; kw: string[] }[] = [
  { cat: '投诉', kw: [
    'complaint', 'claim', 'defect', 'defective', 'quality issue', 'quality problem',
    'not satisfied', 'unsatisfactory', 'unacceptable', 'reject', 'return the goods', 'chargeback', 'penalty',
    '投诉', '索赔', '质量问题', '品质问题', '不合格', '瑕疵', '次品', '返工', '退货', '不满意', '罚款', '扣款',
  ] },
  { cat: '交期', kw: [
    'delivery date', 'ship date', 'shipment date', 'lead time', 'delay', 'delayed', 'postpone', 'deadline',
    'when can you ship', 'when will', 'push back', 'expedite', 'on time', 'behind schedule', 'reschedule',
    '交期', '交货期', '交货时间', '船期', '延期', '推迟', '延误', '什么时候', '何时', '发货时间', '出货时间', '赶货', '催货',
  ] },
  { cat: '样品', kw: [
    'sample', 'proto', 'prototype', 'pp sample', 'pre-production sample', 'salesman sample', 'swatch', 'lab dip', 'counter sample',
    '样品', '样衣', '打样', '产前样', '封样', '色样', '布样', '确认样', '寄样', '回样',
  ] },
  { cat: 'PO', kw: [
    'purchase order', 'order confirmation', 'new order', 'place an order', 'po no', 'po#', 'p.o.',
    '采购订单', '订单确认', '下单', '新订单', '追单', '返单',
  ] },
  { cat: '报价', kw: [
    'quotation', 'quote', 'pricing', 'unit price', 'rfq', 'price list', 'best price', 'cost breakdown',
    '报价', '价格', '询价', '单价', '核价', '成本',
  ] },
  { cat: '物流', kw: [
    'booking', 'container', 'bill of lading', ' b/l', 'forwarder', 'customs', 'vessel', 'shipping mark', 'packing list', 'etd', 'eta',
    '订舱', '提单', '报关', '货代', '柜', '清关', '装箱单', '唛头', '出运',
  ] },
];

// 加急/严重信号 → 抬重点度。
const URGENT = ['urgent', 'asap', 'immediately', 'critical', 'emergency', '紧急', '加急', '尽快', '立刻', '马上', '严重'];

export interface RuleResult {
  category: MailCategory;
  importanceHint: 1 | 2 | 3;   // 1 一般 / 2 需关注 / 3 重点(进重点监控)
  isNoise: boolean;
  matched: string[];           // 命中的关键词(可解释)
}

function hits(hay: string, kws: string[]): string[] {
  return kws.filter((k) => hay.includes(k));
}

/** 规则分类(纯函数)。subject 权重更高,但都在同一 haystack 里匹配。 */
export function ruleClassify(subject: string | null | undefined, body: string | null | undefined): RuleResult {
  const subj = String(subject || '').toLowerCase();
  const text = (subj + '\n' + String(body || '').toLowerCase()).slice(0, 4000);   // 截断省事

  // 噪音优先:命中即判噪音(主题命中权重更高,但正文命中也算)
  const noiseHits = hits(text, NOISE);
  if (noiseHits.length > 0) {
    return { category: '噪音', importanceHint: 1, isNoise: true, matched: noiseHits };
  }

  // 按优先级取第一个命中的类别
  let chosen: MailCategory = '其他';
  let matched: string[] = [];
  for (const rule of RULES) {
    const m = hits(text, rule.kw);
    if (m.length > 0) { chosen = rule.cat; matched = m; break; }
  }

  // 重点度:投诉恒 3;交期/加急 → 3;样品/PO → 2;其余 1。主题命中比正文命中更值钱。
  const urgent = hits(subj, URGENT).length > 0 || hits(text, URGENT).length > 0;
  let importanceHint: 1 | 2 | 3 = 1;
  if (chosen === '投诉') importanceHint = 3;
  else if (chosen === '交期') importanceHint = urgent ? 3 : 3;   // 交期变更本身即重点
  else if (chosen === '样品' || chosen === 'PO') importanceHint = urgent ? 3 : 2;
  else if (urgent) importanceHint = 2;

  return { category: chosen, importanceHint, isNoise: false, matched };
}
