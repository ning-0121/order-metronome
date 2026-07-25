/**
 * Knowledge Layer K1 — Material Decision Trigger Policy（纯函数，客户端/服务端共用）
 *
 * 职责：判断一次 BOM 行编辑/删除「是否关键决策、属哪种 decision_type」。
 * 不弹框骚扰普通编辑 —— 只有真正有下游成本/采购后果的改动才捕获（详见 Q3 / 设计文档）。
 *
 * 铁律：
 *  - 非模板来源 且 未提交采购 → 一律普通编辑（还在搭初始 BOM，不算 Override）。
 *  - 模板来源(未提交) → 单耗/数量相对变化 ≥ 阈值、或换料、或删除 = 关键决策。
 *  - 已提交采购后 → 阈值=0，任何实质变化都是关键决策。
 */

import {
  CONSUMPTION_CHANGE_THRESHOLD_PCT,
  type BomLineSnapshot,
  type BomLineContext,
  type DecisionType,
} from './types';

export interface ClassifyResult {
  isKeyDecision: boolean;
  decisionType: DecisionType | null;
  changedFields: string[];
  /** 相对变化幅度（单耗/数量），供 UI 展示与阈值判断 */
  consumptionDeltaPct: number | null;
  qtyDeltaPct: number | null;
}

const s = (v: any): string => (v ?? '').toString().trim().toLowerCase();
const n = (v: any): number | null => {
  if (v === '' || v == null) return null;
  const x = Number(v);
  return isNaN(x) ? null : x;
};

/** 相对变化：|new-old|/|old|；old 为 0/空时，new 非空即视为 1（100%，必过阈值）。 */
function relDelta(oldV: any, newV: any): number | null {
  const a = n(oldV);
  const b = n(newV);
  if (a == null && b == null) return null;
  if (a == null || a === 0) return b == null || b === 0 ? 0 : 1;
  if (b == null) return 1;
  return Math.abs(b - a) / Math.abs(a);
}

function identityChanged(before: BomLineSnapshot, after: BomLineSnapshot): boolean {
  // material_master_id 变 = 明确换料；否则看 material_name/code 文本变化
  if (before.material_master_id != null || after.material_master_id != null) {
    if (s(before.material_master_id) !== s(after.material_master_id)) return true;
  }
  return s(before.material_name) !== s(after.material_name)
    || (s(before.material_code) !== s(after.material_code) && !!s(after.material_code));
}

/**
 * 分类一次「编辑」。after 是合并 patch 后的完整快照（或至少含被改字段）。
 */
export function classifyBomEdit(
  before: BomLineSnapshot,
  after: BomLineSnapshot,
  ctx: BomLineContext,
): ClassifyResult {
  const changed: string[] = [];

  const swap = identityChanged(before, after);
  if (swap) changed.push('material');

  // 单耗：qty_per_piece 优先，其次大货单耗 production_consumption
  const consDelta = relDelta(before.qty_per_piece, after.qty_per_piece);
  const prodConsDelta = relDelta(before.production_consumption, after.production_consumption);
  const consumptionDeltaPct = [consDelta, prodConsDelta].filter(x => x != null).reduce<number | null>(
    (m, x) => (m == null ? x! : Math.max(m, x!)), null,
  );
  if (s(before.qty_per_piece) !== s(after.qty_per_piece)) changed.push('qty_per_piece');
  if (s(before.production_consumption) !== s(after.production_consumption)) changed.push('production_consumption');

  // 数量/超采比
  const totalDelta = relDelta(before.total_qty, after.total_qty);
  const overDelta = relDelta(before.over_purchase_pct, after.over_purchase_pct);
  const qtyDeltaPct = [totalDelta, overDelta].filter(x => x != null).reduce<number | null>(
    (m, x) => (m == null ? x! : Math.max(m, x!)), null,
  );
  if (s(before.total_qty) !== s(after.total_qty)) changed.push('total_qty');
  if (s(before.over_purchase_pct) !== s(after.over_purchase_pct)) changed.push('over_purchase_pct');

  const supplierChanged = s(before.supplier) !== s(after.supplier) && !!s(after.supplier);
  if (supplierChanged) changed.push('supplier');

  // 前置门：非模板来源 且 未提交 → 一律普通编辑
  if (!ctx.isTemplateSourced && !ctx.isSubmitted) {
    return { isKeyDecision: false, decisionType: null, changedFields: changed, consumptionDeltaPct, qtyDeltaPct };
  }

  // 已提交 → 阈值=0（任何实质变化都记）；模板来源(未提交) → 用阈值
  const eff = ctx.isSubmitted ? 0 : CONSUMPTION_CHANGE_THRESHOLD_PCT;

  let decisionType: DecisionType | null = null;
  if (swap) {
    decisionType = 'material_swap';
  } else if (consumptionDeltaPct != null && consumptionDeltaPct >= eff && (consDelta != null || prodConsDelta != null)) {
    decisionType = 'consumption_change';
  } else if (qtyDeltaPct != null && qtyDeltaPct >= eff && (totalDelta != null || overDelta != null)) {
    decisionType = 'qty_override';
  } else if (supplierChanged && ctx.isSubmitted) {
    // 换供应商仅在已提交后算关键（未提交换供应商=还在选源）
    decisionType = 'supplier_change';
  }

  return {
    isKeyDecision: decisionType != null,
    decisionType,
    changedFields: changed,
    consumptionDeltaPct,
    qtyDeltaPct,
  };
}

/**
 * 分类一次「删除」。删除模板来源/已提交行 = 关键决策（删掉工程物料/采购承诺）。
 */
export function classifyBomDelete(ctx: BomLineContext): ClassifyResult {
  const key = ctx.isTemplateSourced || ctx.isSubmitted;
  return {
    isKeyDecision: key,
    decisionType: key ? 'line_delete' : null,
    changedFields: key ? ['deleted'] : [],
    consumptionDeltaPct: null,
    qtyDeltaPct: null,
  };
}

/** 从一行 materials_bom（DB 行）提取可比较快照。 */
export function toSnapshot(row: Record<string, any> | null | undefined): BomLineSnapshot {
  const r = row || {};
  return {
    material_name: r.material_name ?? null,
    material_code: r.material_code ?? null,
    material_master_id: r.material_master_id ?? null,
    qty_per_piece: r.qty_per_piece ?? null,
    production_consumption: r.production_consumption ?? null,
    total_qty: r.total_qty ?? null,
    over_purchase_pct: r.over_purchase_pct ?? null,
    unit: r.unit ?? null,
    supplier: r.supplier ?? null,
    spec: r.spec ?? null,
    color: r.color ?? null,
  };
}

/** 上下文提取。 */
export function toContext(row: Record<string, any> | null | undefined): BomLineContext {
  const r = row || {};
  return {
    isTemplateSourced: r.product_bom_template_id != null,
    isSubmitted: (r.submit_status ?? '') === 'submitted',
  };
}
