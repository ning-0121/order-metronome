/**
 * Customer Memory Card V1.2 — rule-based, no heavy AI.
 * customer_id: V1 uses customer_name (text) as identifier.
 *
 * V1.2 变更（2026-04-17）：
 *  - 新增 source_type: milestone_blocked（从里程碑阻塞记录自动采集）
 *  - 新增 source_type: repeat_order_review（翻单回顾）
 *  - 新增 category: approval_speed（客户审批速度画像）
 *  - 新增 category: payment_behavior（付款行为画像）
 *  - 新增 category: communication_style（客户沟通风格）
 *  - 扩展关键词库（中英双语）
 *  - 新增 7 个模板（审批/付款/沟通类）
 */
export type CustomerMemorySourceType =
  | 'delay_request'
  | 'delay_approval'
  | 'repeated_blocked'
  | 'milestone_blocked'      // V1.2: 自动从里程碑阻塞记录采集
  | 'repeat_order_review'    // V1.2: 翻单回顾自动写入
  | 'manual'
  | 'mail';

export type CustomerMemoryCategory =
  | 'delay'
  | 'quality'
  | 'logistics'
  | 'general'
  | 'fabric_quality'
  | 'packaging'
  | 'plus_size_stretch'
  | 'approval_speed'       // V1.2: 客户审批速度（产前样/文件确认）
  | 'payment_behavior'     // V1.2: 付款行为（T/T 到账速度、尾款跟催情况）
  | 'communication_style'  // V1.2: 沟通风格（响应速度、确认细节度）
  // V1.3: 客户档案维度（业务员手填，交接知识库）
  | 'brand'                // 客户品牌
  | 'order_habit'          // 下单习惯
  | 'sample_confirm'       // 样衣确认规则与时间
  | 'pricing'              // 固定品价格 / 价格演变原因
  | 'inspection'           // 验货标准
  | 'lead_time'            // 订单周期
  | 'special_requirement'; // 重要事项 / 个性化品质要求

export type CustomerMemoryRiskLevel = 'low' | 'medium' | 'high';

export interface CustomerMemoryRecord {
  id: string;
  customer_id: string;
  order_id: string | null;
  source_type: CustomerMemorySourceType;
  content: string;
  category: CustomerMemoryCategory;
  risk_level: CustomerMemoryRiskLevel;
  created_by: string | null;
  created_at: string;
  content_json?: Record<string, unknown> | null;
}

export const SOURCE_LABELS: Record<CustomerMemorySourceType, string> = {
  delay_request: '延期申请',
  delay_approval: '延期审批',
  repeated_blocked: '反复卡住',
  milestone_blocked: '节点阻塞记录',
  repeat_order_review: '翻单回顾',
  manual: '执行备注',
  mail: '客户邮件',
};

export const CATEGORY_LABELS: Record<CustomerMemoryCategory, string> = {
  delay: '交期',
  quality: '质量',
  logistics: '物流',
  general: '综合',
  fabric_quality: '面料/品质',
  packaging: '包装',
  plus_size_stretch: '大码/弹力',
  approval_speed: '审批速度',
  payment_behavior: '付款行为',
  communication_style: '沟通风格',
  brand: '客户品牌',
  order_habit: '下单习惯',
  sample_confirm: '样衣确认',
  pricing: '价格/价格演变',
  inspection: '验货标准',
  lead_time: '订单周期',
  special_requirement: '个性化要求',
};

export const RISK_LABELS: Record<CustomerMemoryRiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

/** V1.2 Keywords per category for trigger/relevance. Lowercase for matching. */
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  fabric_quality: [
    'fabric', 'color', 'pilling', 'shrinkage', 'staining', 'light color', 'fastness',
    '色牢度', '缩水', '起球', '移色', '浅色', '面料', '染色', '色差',
  ],
  packaging: [
    'packaging', 'carton', 'hangtag', 'barcode', 'label', 'polybag', 'hanger',
    '包装', '外箱', '吊牌', '条形码', '贴标', '胶袋', '衣架',
  ],
  plus_size_stretch: [
    'plus size', 'xl', '2xl', '3xl', 'stretch', 'burst', 'seam',
    '大码', '弹力', '爆缝', '缝制', '加肥', '宽松',
  ],
  delay: ['delay', 'approval', '延期', '审批', 'late', '迟', '推迟'],
  // V1.2 新增
  approval_speed: [
    'sample', 'confirm', 'approval', 'approve', 'sign off', 'review', 'feedback',
    '产前样', '确认', '审批', '审核', '回复', '反馈', '签样', '样品',
  ],
  payment_behavior: [
    'payment', 'tt', 't/t', 'deposit', 'balance', 'invoice', 'wire', 'remittance',
    '付款', '到账', '尾款', '定金', '汇款', '付清', '收款', '电汇',
  ],
  communication_style: [
    'response', 'reply', 'email', 'wechat', 'urgent', 'change', 'revision', 'update',
    '回复', '沟通', '微信', '改款', '修改', '变更', '及时', '响应',
  ],
};

/** V1.1 Seeded memory templates — staff can use and edit when attaching to customer. */
export interface MemoryTemplate {
  id: string;
  content: string;
  category: CustomerMemoryCategory;
  risk_level: CustomerMemoryRiskLevel;
  group: 'fabric_quality' | 'packaging' | 'plus_size_stretch';
}

export interface MemoryTemplateV12 extends MemoryTemplate {
  group: 'fabric_quality' | 'packaging' | 'plus_size_stretch' | 'approval_speed' | 'payment_behavior' | 'communication_style';
  category: CustomerMemoryCategory;
}

/**
 * Score and return top N relevant memories. HIGH first, then MEDIUM; then by category-keyword match.
 * contextString: order notes + milestone names/notes + delay reason_type/detail (lowercased).
 */
export function getTopRelevantMemories(
  memories: { id: string; category: string; risk_level: string; content: string; created_at: string; [k: string]: any }[],
  contextString: string,
  topN: number = 3
): typeof memories {
  const ctx = (contextString || '').toLowerCase();
  const riskOrder = (r: string) => (r === 'high' ? 2 : r === 'medium' ? 1 : 0);

  const scored = memories.map((m) => {
    let match = 0;
    const keywords = CATEGORY_KEYWORDS[m.category] ?? [];
    for (const kw of keywords) {
      if (ctx.includes(kw.toLowerCase())) {
        match = 1;
        break;
      }
    }
    return { m, risk: riskOrder(m.risk_level), match, created: m.created_at };
  });

  scored.sort((a, b) => {
    if (b.risk !== a.risk) return b.risk - a.risk;
    if (b.match !== a.match) return b.match - a.match;
    return (b.created || '').localeCompare(a.created || '');
  });

  return scored.slice(0, topN).map((x) => x.m);
}
