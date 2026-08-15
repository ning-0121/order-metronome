// ============================================================
// ProcurementRepository Contract —— Phase 0.5 之后第一个按 capability 设计的契约
//
// 铁律(docs/Designs/P0P1-Procurement-Architecture-Cut.md §3):
//   本文件只有 **persistence 语义**。以下一律不许出现在这里,留在 Domain/Application:
//     requirement calculation / consumption_basis decision / readiness decision /
//     supplier grouping policy / confirm purchase policy / approval /
//     audit orchestration / notification orchestration
//
//   反面测试:出现 approveProcurement() / calculateMaterialRequirement() /
//   decideSupplierGrouping() / canConfirmPurchase() → 这一刀切错了。
//
// 按 capability 设计,不按表设计:一个方法内部涉及几张表是 Adapter 的问题。
// ============================================================

/** DB error 一律转成它 —— PostgrestError 不许泄漏到 Application/Domain。 */
export class RepositoryError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'permission' | 'io',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/** 订单身份(Pilot 判定只需要这两个号,不该为此把整张 order 拉出来)。 */
export interface OrderIdentity {
  id: string;
  orderNo: string | null;
  internalOrderNo: string | null;
}

/** 归并所需的上游事实。一次取齐,避免 Application 里散着六个读。 */
export interface ProcurementSource {
  order: {
    id: string;
    orderNo: string | null;
    quantity: number | null;
    factoryDate: string | null;
    etd: string | null;
  };
  bom: Array<{
    id: string;
    materialName: string | null;
    materialCode: string | null;
    qtyPerPiece: number | null;
    unit: string | null;
    color: string | null;
    spec: string | null;
    styleNo: string | null;
    totalQty: number | null;
    /** 口径事实(跟单持有)。未确认 = null/空/未知值 —— 判定归 Domain,本层只搬运。 */
    consumptionBasis: string | null;
    materialMasterId: string | null;
  }>;
  requirementCount: number;
}

/** 采购草稿现状(读) */
export interface ProcurementDraft {
  items: Array<{
    id: string;
    consolidationKey: string;
    materialName: string | null;
    color: string | null;
    unit: string | null;
    finalPurchaseQty: number | null;
    suggestedPurchaseQty: number | null;
    needsReconfirm: boolean;
    status: string;
  }>;
  executionLines: Array<{
    id: string;
    procurementItemId: string | null;
    size: string | null;
    orderedQty: number | null;
    /** canonical 执行状态。读时用 effectiveLineStatus() 兼容旧行,写时只写这一列。 */
    lineStatus: string | null;
    /** legacy compatibility debt —— 只读,新事实绝不写它。 */
    legacyStatus: string | null;
    purchaseOrderId: string | null;
  }>;
}

/** Application 已经算好的落库意图 —— Repository 不再判断"该不该"。 */
export interface ProcurementDraftMutation {
  upsertItems?: Array<{ consolidationKey: string; fields: Record<string, unknown> }>;
  updateItems?: Array<{ id: string; fields: Record<string, unknown> }>;
  deleteItemIds?: string[];
  insertExecutionLines?: Array<Record<string, unknown>>;
}

export interface SupplierOption {
  id: string;
  name: string;
  category: string | null;
  defaultLeadDays: number | null;
  contact: string | null;
  isActive: boolean;
}

/** 供应商分组由 Domain 决定;这里只落库。 */
export interface PurchaseOrderPlan {
  orders: Array<{
    supplierId: string | null;
    supplierName: string | null;
    lineIds: string[];
    currency: string | null;
    remark: string | null;
  }>;
}

export interface ProcurementRepository {
  getOrderIdentity(orderId: string): Promise<OrderIdentity | null>;
  getOrderProcurementSource(orderId: string): Promise<ProcurementSource>;
  getProcurementDraft(orderId: string): Promise<ProcurementDraft>;
  saveProcurementDraft(
    orderId: string,
    mutation: ProcurementDraftMutation,
  ): Promise<{ upserted: number; updated: number; deleted: number; linesInserted: number }>;
  getSupplierOptions(filter?: { category?: string; activeOnly?: boolean }): Promise<SupplierOption[]>;
  createPurchaseOrders(orderId: string, plan: PurchaseOrderPlan): Promise<{ purchaseOrderIds: string[] }>;
}

/**
 * P0 只实现读侧三个方法。
 * saveProcurementDraft / getSupplierOptions / createPurchaseOrders 是 P1 —— **故意不提前实现**:
 * 没有调用方的实现无法验证,写了就是负债。P0 的写路径复用既有 consolidate(单一算法,不造第二套)。
 */
export type ProcurementRepositoryP0 = Pick<
  ProcurementRepository,
  'getOrderIdentity' | 'getOrderProcurementSource' | 'getProcurementDraft'
>;
