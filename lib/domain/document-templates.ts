/**
 * 单据中心 — 模板定义
 */

// 公司固定信息
export const COMPANY_INFO = {
  name: '绮陌服饰科技（广州）有限公司',
  name_en: 'Qimo Activewear Technology (Guangzhou) Co., Ltd.',
  address: '广州市番禺区',
  tel: '',
  email: '',
  bank_name: '',
  bank_account: '',
  swift_code: '',
};

// 单据类型
export const DOCUMENT_TYPES = {
  pi: { label: 'PI (形式发票)', icon: '📄', prefix: 'PI' },
  production_sheet: { label: '生产单', icon: '🏭', prefix: 'PS' },
  packing_list: { label: '装箱单', icon: '📦', prefix: 'PL' },
  ci: { label: 'CI (商业发票)', icon: '💰', prefix: 'CI' },
  material_sheet: { label: '原辅料单', icon: '🧵', prefix: 'MS' },
  purchase_order: { label: '采购单', icon: '🛒', prefix: 'PO' },
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;

// 来源模式
export const SOURCE_MODES = {
  ai_generated: { label: 'AI生成', icon: '🤖', color: 'text-purple-600 bg-purple-50' },
  manual_upload: { label: '人工上传', icon: '📤', color: 'text-blue-600 bg-blue-50' },
  manual_created: { label: '人工编辑', icon: '✏️', color: 'text-green-600 bg-green-50' },
} as const;

// 状态
export const DOCUMENT_STATUSES = {
  draft: { label: '草稿', color: 'bg-gray-100 text-gray-700' },
  pending_review: { label: '待审核', color: 'bg-amber-100 text-amber-700' },
  approved: { label: '已审批', color: 'bg-green-100 text-green-700' },
  rejected: { label: '已驳回', color: 'bg-red-100 text-red-700' },
  locked: { label: '已锁定', color: 'bg-indigo-100 text-indigo-700' },
  archived: { label: '已归档', color: 'bg-gray-100 text-gray-500' },
} as const;

// 审批规则：谁提交，谁审批
export const APPROVAL_RULES: Record<string, { submitter: string[]; approver: string[] }> = {
  pi: { submitter: ['sales'], approver: ['finance'] },
  production_sheet: { submitter: ['sales'], approver: ['merchandiser'] },
  packing_list: { submitter: ['merchandiser'], approver: ['finance'] },
  ci: { submitter: ['sales'], approver: ['finance'] },
  material_sheet: { submitter: ['procurement'], approver: ['sales'] },
  purchase_order: { submitter: ['procurement'], approver: ['finance'] },
};

// PI 模板字段
export interface PITemplate {
  pi_no: string;
  date: string;
  buyer: string;
  seller: typeof COMPANY_INFO;
  items: Array<{
    style_no: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
  }>;
  subtotal: number;
  freight: number;
  total: number;
  currency: string;
  payment_terms: string;
  delivery_terms: string;
  port_of_loading: string;
  port_of_destination: string;
  bank_info: string;
  remarks: string;
}

// 生产单模板
export interface ProductionSheetTemplate {
  po_no: string;
  style_no: string;
  customer: string;
  factory: string;
  quantity: number;
  delivery_date: string;
  fabric: string;
  color_breakdown: string;
  size_breakdown: string;
  craft_requirements: string;
  packing_requirements: string;
  trims: string;
  special_notes: string;
}

// 装箱单模板
export interface PackingListTemplate {
  pl_no: string;
  items: Array<{
    carton_no: string;
    style_no: string;
    color: string;
    size_breakdown: string;
    qty_per_carton: number;
    carton_count: number;
    total_qty: number;
    nw_per_carton: number;
    gw_per_carton: number;
    carton_size: string;
    cbm: number;
  }>;
  total_cartons: number;
  total_qty: number;
  total_nw: number;
  total_gw: number;
  total_cbm: number;
}

// CI 模板
export interface CITemplate {
  ci_no: string;
  date: string;
  based_on_pi: string;
  items: Array<{
    style_no: string;
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
  }>;
  total_amount: number;
  currency: string;
  port_of_loading: string;
  port_of_destination: string;
  vessel_voyage: string;
  bl_no: string;
  hs_code: string;
  remarks: string;
}
