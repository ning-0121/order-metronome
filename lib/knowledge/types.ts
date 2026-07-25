/**
 * Knowledge Layer K1 — Material Decision Capture · 类型与常量（单一真相）
 *
 * 定位：记录每次 Material Override 的「原因 / before-after / 证据 / 结果」。
 * 不拥有任何物料/订单/采购主数据 —— 只记录「一次对 materials_bom 的带原因选择」及其结果。
 * 详见 docs/Designs/Knowledge-Layer-K0-K1-V0.1.md。
 */

// ── 决策类型（发生了什么）──
export type DecisionType =
  | 'consumption_change'   // 改单耗（1.20 → 1.28）
  | 'material_swap'        // 换料（A → B）
  | 'line_add'             // 新增物料
  | 'line_delete'          // 删除物料
  | 'qty_override'         // 覆盖数量/超采比
  | 'supplier_change'      // 换供应商
  | 'other';

// ── 原因码（为什么，结构化；材料决策专属，区别于 order_root_causes 的延期/利润口径）──
export type ReasonCode =
  | 'customer_request'       // 客户要求
  | 'supplier_substitute'    // 供应商无货/替代
  | 'price_optimization'     // 降本换料/调量
  | 'lead_time'              // 交期原因
  | 'quality_issue'          // 质量问题
  | 'consumption_correction' // 单耗测算修正（排料实测）
  | 'sample_feedback'        // 样品/产前样反馈
  | 'moq_or_packing'         // 起订量/包装规格凑整
  | 'stock_reuse'            // 用尾料/库存
  | 'spec_change'            // 规格/克重/颜色变更
  | 'data_entry_fix'         // 录入纠错
  | 'other';                 // 其他（reason_note 必填 ≥5 字符）

// 给前端下拉用（value + label），仿 amendment-policy 的 options 约定
export const REASON_CODE_OPTIONS: { value: ReasonCode; label: string }[] = [
  { value: 'customer_request', label: '客户要求' },
  { value: 'supplier_substitute', label: '供应商无货/替代' },
  { value: 'price_optimization', label: '降本换料/调量' },
  { value: 'lead_time', label: '交期原因' },
  { value: 'quality_issue', label: '质量问题' },
  { value: 'consumption_correction', label: '单耗测算修正（实测排料）' },
  { value: 'sample_feedback', label: '样品/产前样反馈' },
  { value: 'moq_or_packing', label: '起订量/包装凑整' },
  { value: 'stock_reuse', label: '用尾料/库存' },
  { value: 'spec_change', label: '规格/克重/颜色变更' },
  { value: 'data_entry_fix', label: '录入纠错' },
  { value: 'other', label: '其他（需填说明）' },
];

// ── 决策状态机（K1 只实现 Decision 状态）──
export type DecisionStatus =
  | 'draft'
  | 'confirmed'
  | 'outcome_pending'
  | 'evaluated'
  | 'closed'
  | 'superseded';

// ── 结果判定（correct / 太低致补料 / 太高致浪费 / 无法判定）──
export type OutcomeResult =
  | 'correct'
  | 'too_low_caused_supplement'
  | 'too_high_caused_waste'
  | 'inconclusive';

// ── 阈值（触发捕获）──
/** 单耗/数量相对变化 ≥ 5% 且行=模板来源时，视为关键决策；已提交采购后阈值=0（任何变化都记）。 */
export const CONSUMPTION_CHANGE_THRESHOLD_PCT = 0.05;

// ── 证据引用（复用 order_attachments；指针，无 FK）──
export interface EvidenceRef {
  attachment_id?: string;   // → order_attachments.id
  url?: string;             // 或外部链接
  note?: string;
}

/** materials_bom 行里与「材料决策」相关的可比较字段快照（before/after 只存这些）。 */
export interface BomLineSnapshot {
  material_name?: string | null;
  material_code?: string | null;
  material_master_id?: string | null;
  qty_per_piece?: number | null;
  production_consumption?: number | null;
  total_qty?: number | null;
  over_purchase_pct?: number | null;
  unit?: string | null;
  supplier?: string | null;
  spec?: string | null;
  color?: string | null;
}

/** 决策来源上下文（用于分类：模板来源 / 已提交采购 决定阈值与是否关键）。 */
export interface BomLineContext {
  isTemplateSourced: boolean;   // product_bom_template_id 非空
  isSubmitted: boolean;         // submit_status === 'submitted'
}

/** 捕获入参（server action 接收；来自 BomTab 或其它编辑路径）。 */
export interface MaterialDecisionCaptureInput {
  orderId: string;
  bomId?: string | null;
  productBomTemplateId?: string | null;
  materialMasterId?: string | null;
  materialName: string;
  materialCode?: string | null;
  decisionType: DecisionType;
  reasonCode: ReasonCode;
  reasonNote?: string | null;
  before: BomLineSnapshot;
  after: BomLineSnapshot;
  estimatedImpactQty?: number | null;
  estimatedImpactAmount?: number | null;
  impactCurrency?: string | null;
  evidenceRefs?: EvidenceRef[];
  scope?: Record<string, any> | null;
}

/** 自动结果信号（投影器只读现有采购表算出，写入 outcome_auto_signals）。 */
export interface OutcomeAutoSignals {
  is_supplement?: boolean;        // 该物料是否出现补料
  supplement_qty?: number | null;
  supplement_reason?: string | null;
  difference_pct?: number | null; // 到货 vs 下单 偏差%
  over_purchase?: boolean | null;
  cost_variance_pct?: number | null; // 材料实际成本 vs 计划
  computed_at?: string;
  note?: string;
}
