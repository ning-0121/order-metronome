/**
 * 单据中心 — 模板定义
 *
 * ⚠️ 这里是**两个不同的法人主体**,不是重复,别合并:
 *   COMPANY_INFO  = 广州主体(绮陌服饰科技(广州)),内部单据用
 *   EXPORT_SELLER = 义乌主体(义乌市绮陌服饰),PL/CI/报关等出口单据用
 * 共用的那部分(义乌主体名、登录域邮箱)取自 lib/config/brand.ts,不再各写各的。
 */
import { BRAND } from '@/lib/config/brand';

// 公司固定信息 —— 广州主体(内部单据)
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

// 出口单据抬头(PL/CI/报关 统一用绮陌自营出口主体)。
// 取自绮陌报关资料模板;email 待用户确认后补(2026-07-09)。
export const EXPORT_SELLER = {
  name_cn: BRAND.legalNameZh,                // 义乌市绮陌服饰有限公司
  name_en: BRAND.legalNameEn,                // YIWU QIMO CLOTHING CO.,LTD
  address_cn: '浙江省义乌市金融六街168号环球大厦2108室',
  address_en: '2108 Room, Global Building, No.168 Financial 6th Street, Yiwu, Zhejiang, China',
  tel: '86-15924281155',
  fax: '0579-81548728',
  email: `alex@${BRAND.emailDomain}`,        // 出口联系邮箱
  usci: '91330782MA2DFE4R9P',                // 统一社会信用代码
  origin: '义乌',                             // 境内货源地 / 原产地
};

/**
 * PI 开票方抬头(2026-07-09 用户拍板统一用义乌主体)。
 *
 * 2026-08-01 收口:这份常量此前**存在两份逐字相同的副本** ——
 * app/actions/order-pi.ts 的 `ISSUER` 和 lib/services/shipping-doc-builders.ts 的 `PI_ISSUER`。
 * 后者注释还写着"与 order-pi.ts 同一常量,统一在此",但那次统一没做完,副本一直留着。
 * 改一处不改另一处,PI 预览和导出的装箱单抬头就会对不上。现在两边都从这里取。
 */
export const PI_ISSUER = {
  company: `${BRAND.legalNameEn}（${BRAND.legalNameZh}）`,
  address: '2108 Room, Global Building, No.168 Financial 6th Street, Yiwu City, Zhejiang Province, China',
  contact: `CONTACT: ALEX QIN    TEL: ${EXPORT_SELLER.tel}    FAX: ${EXPORT_SELLER.fax}    EMAIL: ALEX@${BRAND.emailDomain.toUpperCase()}`,
  title: 'PROFORMA INVOICE',
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
