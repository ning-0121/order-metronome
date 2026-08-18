// ============================================================
// Procurement Advance —— P0 Domain(纯函数,零 DB / 零 auth / 零 IO)
//
// 消灭的是这道**隐藏人工门**:
//   今天 submitBomToProcurement 只写 snapshot + material_plans + material_requirements,
//   **不调用 consolidate** —— 采购必须自己去 ProcurementItemsTab 点「归并」才看得到东西。
//   (自动调 consolidate 的只有 order-amendments / order-quantity-correction 四处改单路径。)
//
// P0 的成功标准**不是**「点提交后一定生成采购项」,而是:
//   点提交后系统一定自动进入**正确的下一状态** —— 要么生成采购需求,
//   要么明确告诉跟单还缺哪个 BOM 事实。**绝不静默停住。**
//
// 因此本模块只做一件事:根据事实判定下一状态。谁去执行、怎么落库,不归它管。
// ============================================================

import { checkBasisReadiness, NEEDS_BOM_CONFIRMATION } from './consumption-basis';

export type AdvanceKind =
  /** 不在 Pilot 白名单 —— 老行为,一个字节都不改 */
  | 'NOT_PILOT'
  /** BOM 为空:提交本身就不该发生,交回跟单 */
  | 'NO_BOM'
  /** 口径未确认:草稿不自动生成,明确告诉跟单缺哪些物料 */
  | typeof NEEDS_BOM_CONFIRMATION
  /** MRP 没跑出需求:系统侧异常,不能静默 */
  | 'NO_REQUIREMENTS'
  /** 事实齐全,可以归并出采购需求 */
  | 'READY_TO_CONSOLIDATE';

export interface AdvanceDecision {
  kind: AdvanceKind;
  /** 是否应当执行归并(只有 READY_TO_CONSOLIDATE 为 true) */
  shouldConsolidate: boolean;
  /** 下一步该找谁 —— 「只有缺事实时才找正确的人」 */
  nextActor: 'merchandiser' | 'procurement' | 'system' | 'none';
  /** 说人话的状态描述,直接可以显示给用户 */
  message: string;
  /** 缺口明细(NEEDS_BOM_CONFIRMATION 时非空):未确认口径的物料名 */
  missingBasisMaterials: string[];
}

export interface AdvanceInput {
  isPilot: boolean;
  bom: Array<{ materialName?: string | null; consumptionBasis?: string | null }>;
  requirementCount: number;
}

/**
 * 判定 BOM 提交之后系统该进入哪个状态。
 *
 * 顺序即优先级:Pilot 闸 → 有没有 BOM → 口径齐不齐 → 需求跑出来没有 → 可归并。
 * 每条分支都返回明确 kind + 说人话的 message —— **没有任何一条是静默 return**。
 */
export function decideProcurementAdvance(input: AdvanceInput): AdvanceDecision {
  if (!input.isPilot) {
    return {
      kind: 'NOT_PILOT',
      // 非 Pilot 仍然归并(2026-08-18 CEO):归并本身不是"新逻辑",
      // 它产出的项与采购手动点「归并」逐字段相同 —— 人工门只是多一步,不改变正确性。
      // Pilot 独有的是**口径就绪门禁**(NEEDS_BOM_CONFIRMATION):非 Pilot 单
      // 口径未确认时沿用历史 PER_SET 兜底,不在这里一刀切卡住全公司。
      shouldConsolidate: true,
      nextActor: 'procurement',
      message: '已生成待采购需求(该订单未接入 Pilot 的口径门禁,用量口径未确认时按历史口径计算)。',
      missingBasisMaterials: [],
    };
  }

  const bom = input.bom || [];
  if (bom.length === 0) {
    return {
      kind: 'NO_BOM',
      shouldConsolidate: false,
      nextActor: 'merchandiser',
      message: '原辅料单为空,无法生成采购需求 —— 请先录入物料。',
      missingBasisMaterials: [],
    };
  }

  // 口径是 BOM truth 的一部分,归跟单。**绝不按物料名猜**(1022977/1022967 已实证猜错差 2 倍)。
  const readiness = checkBasisReadiness(
    bom.map((b) => ({ material_name: b.materialName, consumption_basis: b.consumptionBasis })),
  );
  if (!readiness.ready) {
    const list = readiness.unconfirmed;
    const shown = list.slice(0, 5).join('、');
    return {
      kind: NEEDS_BOM_CONFIRMATION,
      shouldConsolidate: false,
      nextActor: 'merchandiser',
      message:
        `还有 ${list.length} 个物料没确认用量口径(每套/每件/每部件/整单固定),不能生成采购需求:` +
        `${shown}${list.length > 5 ? ` 等 ${list.length} 项` : ''}。` +
        '请在原辅料单逐项确认后重新提交 —— 系统不会替你猜,猜错数量会差一倍。',
      missingBasisMaterials: list,
    };
  }

  if (input.requirementCount <= 0) {
    return {
      kind: 'NO_REQUIREMENTS',
      shouldConsolidate: false,
      nextActor: 'system',
      message: '物料需求未生成(MRP 返回 0 条),已中止归并以免产生空采购需求。请联系管理员查看提交日志。',
      missingBasisMaterials: [],
    };
  }

  return {
    kind: 'READY_TO_CONSOLIDATE',
    shouldConsolidate: true,
    nextActor: 'procurement',
    message: '物料事实齐全,已自动生成待采购需求。',
    missingBasisMaterials: [],
  };
}

/**
 * Pilot 订单的执行行不变量:必须能反查到唯一 procurement_item_id。
 *
 * 贸易单(Trade Purchase)**不属于**本不变量 —— CEO 2026-08-15 裁定为合法业务例外:
 * Trade Purchase 与 Production Procurement 是不同业务语义,不强迫它进生产采购 item 模型。
 * 本轮不为此新增 source_type 列,按既有 trade 路径识别(见 isTradeLine)。
 */
/** 单一来源:app/actions/trade-purchase.ts 从这里 import,不许各写一份。 */
export const TRADE_BULK_CATEGORY = '成品大货';

export function isTradeLine(line: { category?: string | null; procurementItemId?: string | null }): boolean {
  return String(line?.category ?? '') === TRADE_BULK_CATEGORY;
}

export interface OrphanLineReport {
  ok: boolean;
  /** 无 procurement_item_id 且不是 trade 的执行行 id */
  orphanLineIds: string[];
}

/** 检查 Pilot 订单是否满足「所有生产采购执行行都挂 item」。用于验收与回归。 */
export function checkExecutionLineInvariant(
  lines: Array<{ id: string; procurementItemId?: string | null; category?: string | null }>,
): OrphanLineReport {
  const orphanLineIds = (lines || [])
    .filter((l) => !isTradeLine(l) && !l.procurementItemId)
    .map((l) => l.id);
  return { ok: orphanLineIds.length === 0, orphanLineIds };
}
