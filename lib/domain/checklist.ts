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

  // ── 阶段2：采购/生产预评估 ──────────────────

  order_docs_bom_complete: {
    title: '采购预评估检查清单',
    items: [
      { key: 'fabric_supplier', label: '面料已有供应商', type: 'select', required: true, role: 'procurement', group: '供应商',
        options: ['已有', '需要寻找', '客户指定'] },
      { key: 'trims_supplier', label: '辅料已有供应商', type: 'select', required: true, role: 'procurement', group: '供应商',
        options: ['已有', '需要寻找', '客户指定'] },
      { key: 'material_eta', label: '大致到料时间', type: 'text', required: true, role: 'procurement', group: '交期',
        helpText: '如：下单后15天到料' },
      { key: 'high_risk_material', label: '是否存在高风险材料', type: 'select', required: true, role: 'procurement', group: '风险',
        options: ['无', '有（已标注业务）'] },
      { key: 'risk_note', label: '高风险材料说明', type: 'text', required: false, role: 'procurement', group: '风险',
        helpText: '如有高风险材料，说明具体风险和应对方案' },
      { key: 'bom_uploaded', label: 'BOM文件已上传', type: 'checkbox', required: true, role: 'procurement', group: '文档' },
    ],
  },

  bulk_materials_confirmed: {
    title: '生产预评估检查清单',
    items: [
      { key: 'delivery_feasible', label: '是否能满足交期', type: 'select', required: true, role: 'merchandiser', group: '交期评估',
        options: ['可以', '紧张但可行', '无法满足（需沟通）'] },
      { key: 'delivery_risk_note', label: '交期风险说明', type: 'text', required: false, role: 'merchandiser', group: '交期评估',
        helpText: '如交期紧张或无法满足，说明原因和建议' },
      { key: 'craft_difficulty', label: '工艺难点评估', type: 'select', required: true, role: 'merchandiser', group: '工艺评估',
        options: ['无明显难点', '有难点但可解决', '有重大难点（需沟通）'] },
      { key: 'craft_note', label: '工艺难点说明', type: 'text', required: false, role: 'merchandiser', group: '工艺评估',
        helpText: '如有工艺难点，说明具体内容和解决方案' },
    ],
  },

  // ── 阶段3：工厂匹配 ──────────────────────────

  factory_confirmed: {
    title: '工厂匹配检查清单',
    items: [
      { key: 'product_type_match', label: '产品类型匹配', type: 'checkbox', required: true, role: 'merchandiser', group: '匹配评估' },
      { key: 'price_delivery_match', label: '目标价和交期匹配', type: 'checkbox', required: true, role: 'merchandiser', group: '匹配评估' },
      { key: 'quality_grade_match', label: '品质等级匹配', type: 'checkbox', required: true, role: 'merchandiser', group: '匹配评估' },
      { key: 'primary_factory', label: '第一候选工厂', type: 'text', required: true, role: 'merchandiser', group: '工厂选择' },
      { key: 'backup_factory', label: '备选工厂', type: 'text', required: false, role: 'merchandiser', group: '工厂选择',
        helpText: '建议准备备选工厂以防产能不足' },
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

/** 校验检查清单是否全部必填项已完成 */
export function validateChecklistComplete(
  stepKey: string,
  data: ChecklistData | null
): { valid: boolean; missing: string[] } {
  const config = CHECKLIST_MAP[stepKey];
  if (!config) return { valid: true, missing: [] };

  const missing: string[] = [];
  const responseMap = new Map((data || []).map(r => [r.key, r]));

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
  const responseMap = new Map(data.map(r => [r.key, r]));

  for (const item of config.items) {
    if (item.type !== 'pending_date' || !item.affectsSchedule) continue;
    const response = responseMap.get(item.key);
    if (response?.pending_date) {
      results.push({ key: item.key, label: item.label, pending_date: response.pending_date });
    }
  }

  return results;
}
