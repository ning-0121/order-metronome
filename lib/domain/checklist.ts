/**
 * 节点检查清单系统
 *
 * 设计：
 * - 检查清单定义在代码中（跟 SOP_MAP 同模式），不额外建表
 * - 检查清单响应存在 milestones.checklist_data JSONB 列
 * - 全部必填项勾完才能标记节点完成
 * - "未确认"项可选预计确认日期，影响后续节点排期
 */

import type { OwnerRole } from '@/lib/milestoneTemplate';

// ══════ 类型定义 ══════

export type ChecklistItemType = 'checkbox' | 'select' | 'text' | 'number' | 'pending_date';

export interface ChecklistItemDef {
  key: string;
  label: string;
  type: ChecklistItemType;
  required: boolean;
  role: OwnerRole;
  options?: string[];       // select 类型的选项
  helpText?: string;
  affectsSchedule?: boolean; // pending_date 类型：是否影响排期
  group?: string;           // 分组标题
}

export interface ChecklistConfig {
  title: string;
  items: ChecklistItemDef[];
}

// 存储在 DB 的响应格式
export interface ChecklistItemResponse {
  key: string;
  value: boolean | string | null;
  pending_date?: string;    // ISO date
  updated_at: string;
  updated_by: string;       // user_id
}

export type ChecklistData = ChecklistItemResponse[];

// ══════ 检查清单定义（阶段1-3） ══════

export const CHECKLIST_MAP: Record<string, ChecklistConfig> = {

  // ── 阶段1：订单评审 ──────────────────────────

  po_confirmed: {
    title: 'PO确认检查清单',
    items: [
      { key: 'po_uploaded', label: '客户PO已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'internal_quote_uploaded', label: '内部报价单已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'customer_quote_uploaded', label: '客户最终报价单已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'style_no_verified', label: '款号核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'quantity_verified', label: '数量核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'size_ratio_verified', label: '尺码配比核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'color_verified', label: '颜色核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'delivery_verified', label: '交期核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'incoterm_payment', label: '贸易条款（FOB/DDP）和付款方式确认', type: 'checkbox', required: true, role: 'sales', group: '条款确认' },
      { key: 'special_requirements', label: '特殊要求已标注（浅色/撞色/特殊包装等）', type: 'checkbox', required: true, role: 'sales', group: '条款确认' },
      { key: 'three_doc_ai_verified', label: 'AI三单比对已完成或已确认差异', type: 'checkbox', required: true, role: 'sales', group: 'AI核验' },
    ],
  },

  finance_approval: {
    title: '财务审核检查清单',
    items: [
      { key: 'price_match', label: '客户PO价格与报价一致', type: 'checkbox', required: true, role: 'finance', group: '价格审核' },
      { key: 'profit_rate', label: '利润率', type: 'select', required: true, role: 'finance', group: '价格审核',
        options: ['≥25%（优秀）', '15%-25%（正常）', '<15%（需CEO审批）'],
        helpText: '低于15%需报CEO审核确认' },
      { key: 'currency_payment', label: '币种和付款方式/节点正确', type: 'checkbox', required: true, role: 'finance', group: '条款审核' },
      { key: 'shipping_cost', label: '运费/DDP税费/验货费已核查', type: 'checkbox', required: true, role: 'finance', group: '费用审核' },
      { key: 'no_omission', label: '无遗漏费用项', type: 'checkbox', required: true, role: 'finance', group: '费用审核' },
      { key: 'ceo_approval_needed', label: '是否需要CEO审批', type: 'select', required: true, role: 'finance',
        options: ['不需要', '需要（利润率<15%）', '需要（其他原因）'] },
      { key: 'ceo_approval_note', label: 'CEO审批备注', type: 'text', required: false, role: 'finance',
        helpText: '如需CEO审批，填写具体原因' },
    ],
  },

  order_kickoff_meeting: {
    title: '订单评审会检查清单',
    items: [
      { key: 'style_confirmed', label: '客户最终确认款式', type: 'select', required: true, role: 'sales', group: '款式确认',
        options: ['已确认', '未确认'] },
      { key: 'style_confirm_date', label: '款式预计确认日期', type: 'pending_date', required: false, role: 'sales', group: '款式确认',
        affectsSchedule: true, helpText: '未确认时填写预计日期，将影响后续排期' },
      { key: 'fabric_confirmed', label: '面料/材质确认', type: 'checkbox', required: true, role: 'sales', group: '原辅料确认' },
      { key: 'color_confirmed', label: '颜色确认', type: 'checkbox', required: true, role: 'sales', group: '原辅料确认' },
      { key: 'hand_feel_confirmed', label: '手感确认', type: 'checkbox', required: true, role: 'sales', group: '原辅料确认' },
      { key: 'print_craft_confirmed', label: '印花/工艺确认', type: 'checkbox', required: true, role: 'sales', group: '原辅料确认' },
      { key: 'size_chart_confirmed', label: '尺码表确认', type: 'checkbox', required: true, role: 'sales', group: '规格确认' },
      { key: 'cut_ratio_confirmed', label: '裁剪配比确认', type: 'checkbox', required: true, role: 'sales', group: '规格确认' },
      { key: 'proto_sample_confirmed', label: '头样确认状态', type: 'select', required: true, role: 'sales', group: '样品确认',
        options: ['已确认', '未确认', '无需头样'] },
      { key: 'proto_confirm_date', label: '头样预计确认日期', type: 'pending_date', required: false, role: 'sales', group: '样品确认',
        affectsSchedule: true },
      { key: 'packing_confirmed', label: '包装方式确认', type: 'checkbox', required: true, role: 'sales', group: '包装辅料' },
      { key: 'trims_confirmed', label: '吊牌/洗标/贴纸/包装袋/纸箱等辅料确认', type: 'checkbox', required: true, role: 'sales', group: '包装辅料' },
      { key: 'unconfirmed_note', label: '未确认项备注', type: 'text', required: false, role: 'sales',
        helpText: '如有未确认项，说明具体内容和跟进计划' },
    ],
  },

  production_order_upload: {
    title: '生产单上传检查清单',
    items: [
      { key: 'production_order_file', label: '生产订单已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '含款式、面料、尺码、工艺等完整生产信息' },
      { key: 'trims_sheet_file', label: '原辅料单已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '面辅料明细、用量、供应商信息' },
      { key: 'packing_requirement_file', label: '包装资料已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '装箱方式、唛头、吊牌、洗标等包装要求' },
      { key: 'production_info_complete', label: '确认三份资料完整，可交付生产部', type: 'checkbox', required: true, role: 'sales', group: '确认' },
    ],
  },

  // ── 阶段2：原辅料预评估 + 生产预评估 ──────────────────

  order_docs_bom_complete: {
    title: '原辅料预评估检查清单',
    items: [
      // 采购填写
      { key: 'fabric_supplier', label: '面料供应商状态', type: 'select', required: true, role: 'procurement', group: '采购评估',
        options: ['已有供应商', '需要寻找新供应商', '客户指定供应商'] },
      { key: 'trims_supplier', label: '辅料供应商状态', type: 'select', required: true, role: 'procurement', group: '采购评估',
        options: ['已有供应商', '需要寻找新供应商', '客户指定供应商'] },
      { key: 'material_eta', label: '大致到料时间', type: 'text', required: true, role: 'procurement', group: '采购评估',
        helpText: '如：下单后15天到料' },
      { key: 'material_price_ok', label: '原辅料价格在预算范围内', type: 'select', required: true, role: 'procurement', group: '采购评估',
        options: ['在预算内', '略超预算（可接受）', '超预算较多（需协商）'] },
      { key: 'high_risk_material', label: '是否存在高风险材料', type: 'select', required: true, role: 'procurement', group: '风险评估',
        options: ['无高风险材料', '有（已标注并通知业务）'] },
      { key: 'risk_note', label: '风险材料说明及应对', type: 'text', required: false, role: 'procurement', group: '风险评估',
        helpText: '高弹面料克重偏差、浅色色差风险、特殊工艺面料等' },
      // 业务确认
      { key: 'sales_material_reviewed', label: '业务已审阅采购评估', type: 'checkbox', required: true, role: 'sales', group: '业务确认' },
      { key: 'sales_price_feedback', label: '业务对价格的意见', type: 'select', required: true, role: 'sales', group: '业务确认',
        options: ['价格合适', '需要和客户确认', '需要寻找替代材料'] },
    ],
  },

  bulk_materials_confirmed: {
    title: '生产预评估检查清单',
    items: [
      // 跟单填写
      { key: 'delivery_feasible', label: '交期是否可行', type: 'select', required: true, role: 'merchandiser', group: '交期评估',
        options: ['可以按时完成', '紧张但可行', '无法满足（需沟通客户）'] },
      { key: 'delivery_risk_note', label: '交期风险说明', type: 'text', required: false, role: 'merchandiser', group: '交期评估',
        helpText: '如紧张或无法满足，说明原因和建议方案' },
      { key: 'craft_difficulty', label: '工艺难点评估', type: 'select', required: true, role: 'merchandiser', group: '工艺品质评估',
        options: ['无明显难点', '有难点但可解决', '有重大难点（需特别关注）'] },
      { key: 'craft_note', label: '工艺难点详细说明', type: 'text', required: false, role: 'merchandiser', group: '工艺品质评估',
        helpText: '特殊工艺、复杂印花、面料处理等难点' },
      { key: 'quality_focus', label: '品质重点关注项', type: 'text', required: false, role: 'merchandiser', group: '工艺品质评估',
        helpText: '如：色牢度、缩水率、缝制密度等' },
      { key: 'processing_fee_estimate', label: '加工费预估范围', type: 'text', required: true, role: 'merchandiser', group: '加工费预估',
        helpText: '如：12-15元/件' },
    ],
  },

  // ── 阶段3：工厂匹配 ──────────────────────────

  factory_confirmed: {
    title: '工厂匹配评估（目标价·品质·交期）',
    items: [
      // 目标价评估
      { key: 'factory_quote_price', label: '工厂报价（元/件）', type: 'number', required: true, role: 'merchandiser', group: '目标价评估',
        helpText: '填写工厂给到的加工单价' },
      { key: 'target_price_match', label: '报价 vs 目标价', type: 'select', required: true, role: 'merchandiser', group: '目标价评估',
        options: ['在目标价内', '略超（5%以内，可接受）', '超出较多（需协商客户或换厂）'] },
      // 品质评估
      { key: 'factory_quality_grade', label: '工厂品质等级', type: 'select', required: true, role: 'merchandiser', group: '品质评估',
        options: ['A级（高端客户适用）', 'B级（中端，满足大部分客户）', 'C级（需加强QC管控）'] },
      { key: 'factory_quality_history', label: '历史品质表现', type: 'select', required: true, role: 'merchandiser', group: '品质评估',
        options: ['优秀（无重大投诉）', '一般（有过小问题已改进）', '较差（需特别关注）', '新工厂（无历史数据）'] },
      // 交期评估
      { key: 'factory_capacity_ok', label: '产能是否满足本单交期', type: 'select', required: true, role: 'merchandiser', group: '交期评估',
        options: ['完全满足', '紧张但可行（需跟紧）', '无法满足（需协商交期或分厂）'] },
      { key: 'factory_current_load', label: '工厂当前在手订单量', type: 'select', required: false, role: 'merchandiser', group: '交期评估',
        options: ['较空闲（<50%产能）', '正常（50-80%）', '饱和（>80%需注意）'] },
      // 最终确认
      { key: 'primary_factory', label: '确定工厂', type: 'text', required: true, role: 'merchandiser', group: '最终确认' },
      { key: 'backup_factory', label: '备选工厂', type: 'text', required: false, role: 'merchandiser', group: '最终确认',
        helpText: '建议准备备选以防产能不足' },
      { key: 'factory_match_conclusion', label: '综合评估结论', type: 'select', required: true, role: 'merchandiser', group: '最终确认',
        options: ['推荐（价格+品质+交期均满足）', '可接受（有风险点但可控）', '不推荐（需换厂或协商客户）'] },
    ],
  },

  // ── 阶段4：生产启动/开裁 ────────────────────

  production_kickoff: {
    title: '开裁前单耗确认',
    items: [
      { key: 'quote_consumption', label: '报价单耗（米/件）', type: 'number', required: true, role: 'merchandiser', group: '单耗对比',
        helpText: '内部报价时的面料单耗' },
      { key: 'actual_consumption', label: '工厂排料实际单耗（米/件）', type: 'number', required: true, role: 'merchandiser', group: '单耗对比',
        helpText: '工厂排料后的实际单耗，必须 ≤ 报价单耗才可开裁' },
      { key: 'consumption_pass', label: '单耗核验通过', type: 'checkbox', required: true, role: 'merchandiser', group: '单耗对比',
        helpText: '确认实际单耗 ≤ 报价单耗，允许开裁' },
    ],
  },

  // ── 阶段5：中查 ────────────────────────────

  mid_qc_check: {
    title: '中查检查清单',
    items: [
      // 跟单填写
      { key: 'qc_date', label: '验货日期', type: 'text', required: true, role: 'merchandiser', group: '跟单验货' },
      { key: 'qc_qty_inspected', label: '抽检数量', type: 'number', required: true, role: 'merchandiser', group: '跟单验货' },
      { key: 'qc_defect_found', label: '发现不良', type: 'select', required: true, role: 'merchandiser', group: '跟单验货',
        options: ['无不良', '轻微（可接受）', '一般（需整改）', '严重（需停产整改）'] },
      { key: 'qc_defect_detail', label: '不良问题描述', type: 'text', required: false, role: 'merchandiser', group: '跟单验货',
        helpText: '如有不良，说明具体问题' },
      { key: 'qc_progress_pct', label: '生产完成进度（%）', type: 'number', required: true, role: 'merchandiser', group: '跟单验货',
        helpText: '如：30、50、70' },
      { key: 'qc_report_uploaded', label: '中查报告已上传', type: 'checkbox', required: true, role: 'merchandiser', group: '跟单验货' },
      // 业务确认
      { key: 'sales_mid_qc_reviewed', label: '业务已审阅中查结果', type: 'checkbox', required: true, role: 'sales', group: '业务确认' },
      { key: 'sales_mid_qc_opinion', label: '业务意见', type: 'select', required: true, role: 'sales', group: '业务确认',
        options: ['同意继续生产', '需要整改后继续', '需要与客户沟通'] },
      { key: 'sales_mid_qc_note', label: '业务备注', type: 'text', required: false, role: 'sales', group: '业务确认' },
    ],
  },

  // ── 阶段5：尾查 ────────────────────────────

  final_qc_check: {
    title: '尾查检查清单',
    items: [
      // 跟单填写
      { key: 'final_qc_date', label: '验货日期', type: 'text', required: true, role: 'merchandiser', group: '跟单验货' },
      { key: 'final_qc_qty', label: '验货数量', type: 'number', required: true, role: 'merchandiser', group: '跟单验货' },
      { key: 'final_qc_aql', label: 'AQL标准', type: 'select', required: true, role: 'merchandiser', group: '跟单验货',
        options: ['AQL 1.5', 'AQL 2.5', 'AQL 4.0', '客户指定标准'] },
      { key: 'final_qc_result', label: '验货结果', type: 'select', required: true, role: 'merchandiser', group: '跟单验货',
        options: ['PASS', 'PENDING（待整改复验）', 'FAIL（不通过）'] },
      { key: 'final_qc_defect_detail', label: '不良问题描述', type: 'text', required: false, role: 'merchandiser', group: '跟单验货' },
      { key: 'final_qc_report_uploaded', label: '尾查报告已上传', type: 'checkbox', required: true, role: 'merchandiser', group: '跟单验货' },
      // 业务确认
      { key: 'sales_final_qc_reviewed', label: '业务已审阅尾查结果', type: 'checkbox', required: true, role: 'sales', group: '业务确认' },
      { key: 'sales_final_qc_opinion', label: '业务意见', type: 'select', required: true, role: 'sales', group: '业务确认',
        options: ['同意出货', '需要整改后复验', '需要与客户沟通', '拒绝出货'] },
      { key: 'sales_final_qc_note', label: '业务备注', type: 'text', required: false, role: 'sales', group: '业务确认',
        helpText: '如有特殊情况说明' },
    ],
  },
};

// ══════ 工具函数 ══════

/** 获取指定节点的检查清单配置 */
export function getChecklistForStep(stepKey: string): ChecklistConfig | null {
  return CHECKLIST_MAP[stepKey] || null;
}

/** 判断节点是否有检查清单 */
export function hasChecklistForStep(stepKey: string): boolean {
  return stepKey in CHECKLIST_MAP;
}

/** 安全解析 checklist_data（可能是 JSON 字符串或数组） */
function parseChecklistData(data: unknown): ChecklistData {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/** 校验检查清单是否全部必填项已完成 */
export function validateChecklistComplete(
  stepKey: string,
  data: ChecklistData | null
): { valid: boolean; missing: string[] } {
  const config = CHECKLIST_MAP[stepKey];
  if (!config) return { valid: true, missing: [] };

  const missing: string[] = [];
  const safeData = parseChecklistData(data);
  const responseMap = new Map(safeData.map(r => [r.key, r]));

  for (const item of config.items) {
    if (!item.required) continue;
    const response = responseMap.get(item.key);
    if (!response || response.value === null || response.value === '' || response.value === false) {
      missing.push(item.label);
    }
  }

  return { valid: missing.length === 0, missing };
}

/** 获取影响排期的未确认项 */
export function getScheduleAffectingItems(
  stepKey: string,
  data: ChecklistData | null
): { key: string; label: string; pending_date: string }[] {
  const config = CHECKLIST_MAP[stepKey];
  if (!config || !data) return [];

  const results: { key: string; label: string; pending_date: string }[] = [];
  const safeData = parseChecklistData(data);
  const responseMap = new Map(safeData.map(r => [r.key, r]));

  for (const item of config.items) {
    if (item.type !== 'pending_date' || !item.affectsSchedule) continue;
    const response = responseMap.get(item.key);
    if (response?.pending_date) {
      results.push({ key: item.key, label: item.label, pending_date: response.pending_date });
    }
  }

  return results;
}
