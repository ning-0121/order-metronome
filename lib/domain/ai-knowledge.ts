/**
 * AI 知识库数据管道 — 类型与常量定义
 *
 * 设计目标：
 * 1. 统一采集：员工数据、客户订单、工厂数据、备注复盘 → 知识库
 * 2. 行业标签：标注行业 + 规模 + 市场，为 SaaS 推广做准备
 * 3. 通道化：每种数据源有标准的采集→处理→入库流程
 */

// ══════ 知识类型 ══════
export type KnowledgeType =
  | 'employee'    // 员工效率/行为模式
  | 'customer'    // 客户智能（偏好、风险、习惯）
  | 'factory'     // 工厂智能（品质、产能、问题）
  | 'process'     // 流程优化（瓶颈、最佳实践）
  | 'industry';   // 行业通用知识

// ══════ 数据来源 ══════
export type KnowledgeSource =
  | 'retrospective'       // 订单复盘
  | 'customer_memory'     // 客户记忆
  | 'milestone_log'       // 关卡操作日志
  | 'delay_request'       // 延期申请
  | 'production_report'   // 生产日报
  | 'memo'                // 员工备忘录
  | 'manual';             // 人工录入

// ══════ 行业分类 ══════
export const INDUSTRY_OPTIONS = [
  { value: 'apparel', label: '服装' },
  { value: 'textile', label: '纺织面料' },
  { value: 'accessories', label: '服饰配件' },
  { value: 'footwear', label: '鞋业' },
  { value: 'home_textile', label: '家纺' },
  { value: 'other', label: '其他' },
] as const;

export const INDUSTRY_SUB_OPTIONS: Record<string, { value: string; label: string }[]> = {
  apparel: [
    { value: 'casual_wear', label: '休闲装' },
    { value: 'sportswear', label: '运动装' },
    { value: 'workwear', label: '工装' },
    { value: 'underwear', label: '内衣' },
    { value: 'children', label: '童装' },
    { value: 'formal', label: '正装' },
    { value: 'outdoor', label: '户外服装' },
  ],
  textile: [
    { value: 'knit', label: '针织' },
    { value: 'woven', label: '梭织' },
    { value: 'denim', label: '牛仔' },
  ],
};

// ══════ 公司规模 ══════
export const SCALE_OPTIONS = [
  { value: 'micro', label: '微型（<10人）' },
  { value: 'small', label: '小型（10-50人）' },
  { value: 'medium', label: '中型（50-200人）' },
  { value: 'large', label: '大型（200+人）' },
] as const;

// ══════ 年订单量 ══════
export const ORDER_VOLUME_OPTIONS = [
  { value: '<50', label: '<50单/年' },
  { value: '50-200', label: '50-200单/年' },
  { value: '200-500', label: '200-500单/年' },
  { value: '500+', label: '500+单/年' },
] as const;

// ══════ 知识类别映射 ══════
export const KNOWLEDGE_TYPE_LABELS: Record<KnowledgeType, string> = {
  employee: '员工效率',
  customer: '客户智能',
  factory: '工厂智能',
  process: '流程优化',
  industry: '行业通用',
};

export const KNOWLEDGE_SOURCE_LABELS: Record<KnowledgeSource, string> = {
  retrospective: '订单复盘',
  customer_memory: '客户记忆',
  milestone_log: '关卡日志',
  delay_request: '延期申请',
  production_report: '生产日报',
  memo: '员工备忘',
  manual: '人工录入',
};

// ══════ 知识条目接口 ══════
export interface KnowledgeEntry {
  id: string;
  knowledge_type: KnowledgeType;
  category: string;
  subcategory?: string;
  title: string;
  content: string;
  structured_data?: Record<string, unknown>;
  source_type: KnowledgeSource;
  source_id?: string;
  source_table?: string;
  customer_name?: string;
  factory_name?: string;
  order_id?: string;
  employee_role?: string;
  industry_tag: string;
  scale_tag: string;
  market_tags: string[];
  confidence: 'high' | 'medium' | 'low';
  frequency: number;
  impact_level: 'high' | 'medium' | 'low';
  is_actionable: boolean;
  status: 'active' | 'archived' | 'merged';
  created_at: string;
}

// ══════ 公司画像接口 ══════
export interface CompanyProfile {
  id: string;
  company_name: string;
  industry: string;
  industry_sub?: string;
  company_scale: string;
  annual_order_volume?: string;
  main_markets: string[];
  main_products: string[];
  employee_count?: number;
  erp_system?: string;
  pain_points: string[];
  metadata?: Record<string, unknown>;
}

// ══════ 采集日志接口 ══════
export interface CollectionLog {
  id: string;
  run_at: string;
  source_type: string;
  records_scanned: number;
  records_ingested: number;
  records_skipped: number;
  duration_ms?: number;
  error_message?: string;
}

// ══════ 采集统计接口 ══════
export interface KnowledgeStats {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byIndustry: Record<string, number>;
  recentEntries: KnowledgeEntry[];
  lastCollectionRuns: CollectionLog[];
}
