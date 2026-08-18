// ============================================================
// Procurement Advance Command —— P0 Application 层(编排)
//
// ⚠️ 本文件**刻意不是 'use server'**。
//   advanceProcurementAfterBomSubmit 内部用 SYSTEM_ACTOR 跳过采购角色闸;
//   一旦导出成 Server Action,浏览器就能直接调它 —— 等于把提权入口开给所有登录用户。
//   它只允许被服务端代码 import(bom.ts 提交成功后调用)。
//
// 职责:编排。不算需求(Domain 算)、不碰表(Adapter 碰)。
// ============================================================

import { procurementRepo } from '@/lib/adapters/supabase/procurementAdapter';
import { RepositoryError } from '@/lib/repositories/contracts/procurement';
import { decideProcurementAdvance, type AdvanceDecision } from './advance';
import { isPilotOrder } from './pilot';
import { SYSTEM_ACTOR } from './systemActor';

export interface AdvanceResult extends AdvanceDecision {
  /** 归并后订单上的待采购项数(「待采购 N 项」里的 N) */
  draftItemCount: number;
  /** 归并本次新建/更新了多少项(未执行归并时为 0) */
  consolidated: { created: number; updated: number } | null;
  /** 归并失败时的原因 —— 不吞,原样上抛给调用方决定要不要阻断 */
  consolidateError?: string;
}

/**
 * BOM 提交成功后,把订单推进到正确的下一状态。
 *
 * 绝不静默:每条路径都返回明确 kind + 说人话的 message。
 * 绝不猜:consumption_basis 未确认 → NEEDS_BOM_CONFIRMATION,不归并。
 * 绝不阻断主链路:本函数抛错由调用方吞掉(BOM 提交本身已经成功,不能因为推进失败而回滚)。
 */
export async function advanceProcurementAfterBomSubmit(orderId: string): Promise<AdvanceResult> {
  const repo = await procurementRepo();

  const identity = await repo.getOrderIdentity(orderId);
  const isPilot = isPilotOrder({
    order_no: identity?.orderNo ?? null,
    internal_order_no: identity?.internalOrderNo ?? null,
  });

  // 非 Pilot:**不生成新采购需求**(那是 Pilot 在验的新行为),但必须做一次
  // 「只刷新既有采购项」的归并 —— 否则 MRP 已重算、采购项还停在上一版,
  // 采购会一直照着旧数字下单。
  //
  // 1022977 实证(2026-08-18):
  //   08-11 建采购项 11616/6336(数量语义 hotfix 之前的算法)
  //   08-12 hotfix 上线
  //   08-14 重新提交 BOM → material_requirements 重算成 5808/3168 ✅
  //         → 这里 return NOT_PILOT → 归并没跑 → 采购界面至今显示 11616 ❌
  //
  // 切分原则(CEO 2026-08-18):
  //   refresh(刷新既有项总需求)= **数据一致性**,不该被 Pilot 闸住;
  //   create (新建采购项)      = **新的采购意图**,保持 Pilot 限定。
  //   Pilot 白名单是「允许执行新逻辑」的保护闸,不是「只有 Pilot 单才配保持一致」的业务闸。
  //
  // create:false 时 consolidate 对新分组直接 continue,不产生任何新采购意图;
  // 与 HEADER_RECONCILIATION 用的是同一档(order-quantity-correction.ts:273)。
  if (!isPilot) {
    const decision = decideProcurementAdvance({ isPilot: false, bom: [], requirementCount: 0 });
    let refreshed: unknown = null;
    try {
      const { consolidateOrderProcurementItems } = await import('@/app/actions/procurement-items');
      refreshed = await consolidateOrderProcurementItems(orderId, {
        apply: { create: false, refresh: true, cleanup: false },
        systemActor: SYSTEM_ACTOR,
      });
    } catch (e: any) {
      // 刷新失败绝不阻断 BOM 提交(提交本身已成功),记录即可
      console.warn('[advance] 非 Pilot 采购项刷新失败(不阻断):', e?.message);
    }
    return { ...decision, draftItemCount: 0, consolidated: refreshed as any };
  }

  const source = await repo.getOrderProcurementSource(orderId);
  const decision = decideProcurementAdvance({
    isPilot: true,
    bom: source.bom.map((b) => ({ materialName: b.materialName, consumptionBasis: b.consumptionBasis })),
    requirementCount: source.requirementCount,
  });

  if (!decision.shouldConsolidate) {
    const draft = await repo.getProcurementDraft(orderId);
    return { ...decision, draftItemCount: draft.items.length, consolidated: null };
  }

  // 系统归并:算法与采购手动点「归并」完全同一份(不造第二套),只是跳过采购角色闸。
  // cleanup 不开 —— 自动路径不删任何既有采购项,清孤儿仍然只由采购手动确认。
  const { consolidateOrderProcurementItems } = await import('@/app/actions/procurement-items');
  const res = await consolidateOrderProcurementItems(orderId, {
    apply: { create: true, refresh: true, cleanup: false },
    systemActor: SYSTEM_ACTOR,
  });

  const draft = await repo.getProcurementDraft(orderId);
  if ((res as any)?.error) {
    return {
      ...decision,
      kind: 'NO_REQUIREMENTS',
      shouldConsolidate: false,
      nextActor: 'system',
      message: `自动归并未完成:${(res as any).error}`,
      draftItemCount: draft.items.length,
      consolidated: null,
      consolidateError: String((res as any).error),
    };
  }

  return {
    ...decision,
    draftItemCount: draft.items.length,
    consolidated: { created: Number((res as any)?.created) || 0, updated: Number((res as any)?.updated) || 0 },
  };
}

/**
 * Pilot 订单是否禁止走旧 execution-line / 采购台账入口。
 *
 * CEO 2026-08-15 硬验收:Pilot Production execution lines 必须全部 procurement_item_id != null。
 * 旧入口(addProcurementItem / syncFromProcurementTracking / procurement_tracking 七个 writer)
 * 建行时不挂 item_id → Pilot 单必须**服务端硬拒绝**,只藏 UI 按钮挡不住旧页面和 API。
 */
export async function isPilotOrderId(orderId: string): Promise<boolean> {
  try {
    const repo = await procurementRepo();
    const identity = await repo.getOrderIdentity(orderId);
    if (!identity) return false;
    return isPilotOrder({ order_no: identity.orderNo, internal_order_no: identity.internalOrderNo });
  } catch (e) {
    // fail-closed 会把非 Pilot 老订单一起挡住(违反「非 Pilot 零变化」)→ 这里 fail-open,
    // 读不到身份就当不在 Pilot。Pilot 只有 3–5 张单,漏挡的代价远小于挡住全公司。
    if (e instanceof RepositoryError) return false;
    return false;
  }
}

export const LEGACY_ENTRY_BLOCKED_MESSAGE =
  '该订单正在使用新版采购流程,请从待采购需求生成采购执行行,不能从旧对账入口新增。';

/** 旧入口守卫:Pilot 单返回错误文案,非 Pilot 返回 null(行为完全不变)。 */
export async function blockLegacyProcurementEntry(orderId: string): Promise<string | null> {
  return (await isPilotOrderId(orderId)) ? LEGACY_ENTRY_BLOCKED_MESSAGE : null;
}

export const LEGACY_TRACKING_BLOCKED_MESSAGE =
  '该订单正在使用新版采购流程,采购事实请走「采购项 / 执行行」,采购台账对本单已停写(历史记录仍可查看)。';

/**
 * 采购台账(procurement_tracking)停写守卫。
 *
 * 定性:LEGACY / READ-ONLY / NO NEW WRITES。本轮不删表、不迁 365 行、不改非 Pilot 行为。
 * 台账 100% pending、supplier/order_date/到货日/金额全 0 行有值 —— 它是占位符不是事实。
 */
export async function blockLegacyTrackingWrite(orderId: string | null | undefined): Promise<string | null> {
  if (!orderId) return null;
  return (await isPilotOrderId(orderId)) ? LEGACY_TRACKING_BLOCKED_MESSAGE : null;
}
