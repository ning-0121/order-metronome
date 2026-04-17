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
  | 'communication_style'; // V1.2: 沟通风格（响应速度、确认细节度）

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

export const MEMORY_TEMPLATES: MemoryTemplateV12[] = [
  // 面料/品质 (f1-f3)
  {
    id: 'f1',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'high',
    content: '客户对色牢度要求高，必须在 PO/生产单中注明要求，采购选面料时提前确认。',
  },
  {
    id: 'f2',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'high',
    content: '浅色有移色/沾污风险，采购/品控必须提前告知工厂，建议做移色测试。',
  },
  {
    id: 'f3',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'medium',
    content: '客户关注缩水率，需确认缩水公差范围并制定检测方案（大货前至少3次水洗测试）。',
  },
  // 包装 (p1-p2)
  {
    id: 'p1',
    group: 'packaging',
    category: 'packaging',
    risk_level: 'high',
    content: '包装复杂，外箱规格须提前确认，纸箱生产周期约7天，下单时同步启动。',
  },
  {
    id: 'p2',
    group: 'packaging',
    category: 'packaging',
    risk_level: 'medium',
    content: '吊牌/条形码/贴标经常临时更改，出货前必须重新核对最新版本。',
  },
  // 大码/弹力 (s1-s2)
  {
    id: 's1',
    group: 'plus_size_stretch',
    category: 'plus_size_stretch',
    risk_level: 'high',
    content: '大码+高弹力爆缝风险：确认缝纫针距、线料规格和加固方案，产前样必须做穿着测试。',
  },
  {
    id: 's2',
    group: 'plus_size_stretch',
    category: 'plus_size_stretch',
    risk_level: 'medium',
    content: '建议大货前做弹力测试或试穿测试，避免批量问题。',
  },
  // V1.2 审批速度 (a1-a3)
  {
    id: 'a1',
    group: 'approval_speed',
    category: 'approval_speed',
    risk_level: 'high',
    content: '客户产前样确认速度慢（历史超7天），排期时产前样确认节点需预留额外5天缓冲，避免生产启动延误。',
  },
  {
    id: 'a2',
    group: 'approval_speed',
    category: 'approval_speed',
    risk_level: 'medium',
    content: '客户审批需多层级内部流转（买手→主管→采购），建议业务在截止日3天前主动跟进。',
  },
  {
    id: 'a3',
    group: 'approval_speed',
    category: 'approval_speed',
    risk_level: 'low',
    content: '客户审批响应及时（历史平均2-3天），按标准排期即可。',
  },
  // V1.2 付款行为 (pay1-pay3)
  {
    id: 'pay1',
    group: 'payment_behavior',
    category: 'payment_behavior',
    risk_level: 'high',
    content: '尾款回收慢（历史超出账期30天以上），出货后立即发催款邮件，超期7天需升级CEO介入。',
  },
  {
    id: 'pay2',
    group: 'payment_behavior',
    category: 'payment_behavior',
    risk_level: 'medium',
    content: '定金到账偶有拖延，确认 PO 时需明确定金到账时间，未到账不开始采购。',
  },
  {
    id: 'pay3',
    group: 'payment_behavior',
    category: 'payment_behavior',
    risk_level: 'low',
    content: '付款习惯良好，按约定账期准时到账，信用评级高。',
  },
  // V1.2 沟通风格 (c1-c2)
  {
    id: 'c1',
    group: 'communication_style',
    category: 'communication_style',
    risk_level: 'high',
    content: '客户改款频繁（历史改款率高），产前会必须当面确认所有细节并拍照存档，任何变更须书面确认后才能执行。',
  },
  {
    id: 'c2',
    group: 'communication_style',
    category: 'communication_style',
    risk_level: 'medium',
    content: '客户邮件回复慢（工作日内回复），重要确认事项同时发微信/WhatsApp 跟进，避免单纯依赖邮件。',
  },
];

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
