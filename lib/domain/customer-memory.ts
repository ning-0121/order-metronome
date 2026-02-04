/**
 * Customer Memory Card V1 / V1.1 — rule-based, no heavy AI.
 * customer_id: V1 uses customer_name (text) as identifier.
 */
export type CustomerMemorySourceType =
  | 'delay_request'
  | 'delay_approval'
  | 'repeated_blocked'
  | 'manual'
  | 'mail';

export type CustomerMemoryCategory =
  | 'delay'
  | 'quality'
  | 'logistics'
  | 'general'
  | 'fabric_quality'
  | 'packaging'
  | 'plus_size_stretch';

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
};

export const RISK_LABELS: Record<CustomerMemoryRiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

/** V1.1 Keywords per category for trigger/relevance. Lowercase for matching. */
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  fabric_quality: [
    'fabric', 'color', 'pilling', 'shrinkage', 'staining', 'light color', 'fastness',
    '色牢度', '缩水', '起球', '移色', '浅色', '面料', '染色',
  ],
  packaging: [
    'packaging', 'carton', 'hangtag', 'barcode', 'label', 'polybag', 'hanger',
    '包装', '外箱', '吊牌', '条形码', '贴标', '胶袋', '衣架',
  ],
  plus_size_stretch: [
    'plus size', 'xl', '2xl', '3xl', 'stretch', 'burst', 'seam',
    '大码', '弹力', '爆缝', '缝制', '加肥', '宽松',
  ],
  delay: ['delay', 'approval', '延期', '审批', 'packaging', '包装'],
};

/** V1.1 Seeded memory templates — staff can use and edit when attaching to customer. */
export interface MemoryTemplate {
  id: string;
  content: string;
  category: CustomerMemoryCategory;
  risk_level: CustomerMemoryRiskLevel;
  group: 'fabric_quality' | 'packaging' | 'plus_size_stretch';
}

export const MEMORY_TEMPLATES: MemoryTemplate[] = [
  {
    id: 'f1',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'high',
    content: 'Customer is highly sensitive to color fastness; must confirm requirement and mark in PO/production sheet.',
  },
  {
    id: 'f2',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'high',
    content: 'Light colors have staining/color migration risk; must warn procurement/QC and consider testing.',
  },
  {
    id: 'f3',
    group: 'fabric_quality',
    category: 'fabric_quality',
    risk_level: 'medium',
    content: 'Customer cares about shrinkage rate; confirm tolerance and testing plan.',
  },
  {
    id: 'p1',
    group: 'packaging',
    category: 'packaging',
    risk_level: 'high',
    content: 'Packaging is complex; carton spec must be confirmed early; carton production lead time ~7 days.',
  },
  {
    id: 'p2',
    group: 'packaging',
    category: 'packaging',
    risk_level: 'medium',
    content: 'Hangtag/barcode/labeling often changes; must re-check before shipment.',
  },
  {
    id: 's1',
    group: 'plus_size_stretch',
    category: 'plus_size_stretch',
    risk_level: 'high',
    content: 'Plus size + high stretch risk: seam bursting. Confirm stitching/thread/needle density and reinforcement.',
  },
  {
    id: 's2',
    group: 'plus_size_stretch',
    category: 'plus_size_stretch',
    risk_level: 'medium',
    content: 'Recommend stretch test or fit test before bulk.',
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
