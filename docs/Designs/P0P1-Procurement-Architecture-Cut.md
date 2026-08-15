# Procurement Generator P0/P1 — Architecture Cut

> Phase 0.5 之后的第一个纵切。**本文只切边界,不写业务代码。**
> 前置:[P0P1-Procurement-Truth-Map.md](./P0P1-Procurement-Truth-Map.md)(真相判定 + 实测漏斗)、[ADR-006](../ADR/ADR-006-data-access-layering-ratchet.md)(数据访问棘轮)。
> 开发分支必须落在 `chore/data-access-ratchet` 之上 —— 闸要在写代码时就生效,不能等合并前才发现。

---

## 0. 本轮硬约束(CEO 拍板)

四层固定:

```
UI / Server Action
      ↓
Application / Command      编排、事务边界、audit/notification 触发
      ↓
Domain                     纯函数,不碰 DB,不碰 auth
      ↓
Repository Contract        接口,只有 persistence 语义
      ↓
Supabase Adapter           唯一碰表的地方
```

**禁止进入 Repository**:requirement calculation / consumption_basis decision / readiness decision / supplier grouping policy / confirm purchase policy / approval / audit orchestration / notification orchestration。

反面测试:如果 Repository 里出现 `approveProcurement()` / `calculateMaterialRequirement()` / `decideSupplierGrouping()` / `canConfirmPurchase()`,这一刀就切错了。

---

## 1. Current Boundary Cut Map

### 1.1 已经是 Domain —— 零改动,直接复用

这是本轮最好的消息:采购**核心算法早就是纯函数了**,不需要"从 action 里抠出来"。

| 文件 | 内容 | 判定 |
|---|---|---|
| `lib/services/procurement-execution.ts` (244行) | `orderableQty` `distributeBySize` `distributeByWeights` `shouldSplitBySize` `isBulkMaterial` `isFabricCategory` `reconcileBulkQty` `buildExecutionLineRow` `canGenerateExecution` `resolveReceivingStatus` `resolveOrderedStatus` `deriveFulfillment` | ✅ **已是 Domain**,零 DB 依赖 |
| `lib/services/procurement-kernel.ts` (115行) | `shortageTruth` `sourcingTruth` `executionTruth` | ✅ **已是 Domain** |
| `lib/procurement/consumption-basis.ts` (139行) | `isBasisConfirmed` `materialBasisKey` `suggestBasisFromHistory` `suggestBasisForBom` `checkBasisReadiness` | ✅ **已是 Domain**(只认历史,绝不按名字猜) |
| `lib/procurement/status.ts` `receivedQty.ts`(算部分) `floorCosts.ts` `sizeOverride.ts` `reorder.ts` | 派生/换算 | ✅ Domain |
| `lib/procurement/pilot.ts` (49行) | `pilotOrderNos` `isPilotOrder` `isPilotEnabled` | ✅ Application(灰度闸) |

### 1.2 需要切开的混合体

| 现有函数 | 位置 | 现在混了什么 | 切给谁 |
|---|---|---|---|
| `submitBomToProcurement` | `bom.ts:683`(≈375行) | auth + 角色 + MRP 计算 + 快照冻结 + 需求删旧插新 + 通知 | **Application Command**;算量→Domain;5 张表读写→Repository |
| `consolidateOrderProcurementItems` | `procurement-items.ts:774`(≈326行) | 归并键计算 + 单耗基数选择 + DB 读写 + dryRun/apply 语义 | **归并算法→Domain**(纯);读写→Repository;`apply/dryRun`→Application |
| `generateExecutionLines` | `procurement-items.ts:1751` | auth + 角色 + 尺码分摊 + service-role 降级插入 | Application;`buildExecutionLineRow` 已是 Domain;插入→Repository |
| `updateProcurementItemStatus` | `procurement-items.ts:1603`(110行) | 状态机 + 权限 + 副作用 | 状态机→Domain;编排→Application |
| `createPurchaseOrder` | `purchase-orders.ts:95` | 分组 + 建头 + 挂行 + 编号 | **分组策略→Domain**;建头挂行→Repository |
| `approvePurchaseOrder` `placePurchaseOrder` `resubmitPurchaseOrderApproval` | `purchase-orders.ts:618/979/942` | 审批策略 + 财务同步 + 通知 | Application(**绝不进 Repository**) |
| `listProcurementItems` `getProcurementItemSources` `getOrderProcurementFulfillment` | `procurement-items.ts` | 读 + 派生 | 读→Repository;派生已是 Domain(`deriveFulfillment`) |

### 1.3 Legacy —— 本轮不动,只隔离

| 文件 | 判定 |
|---|---|
| `app/actions/procurement-tracking.ts` 全文件(13 处直连) | ⛔ **LEGACY / READ-ONLY / NO NEW WRITES**(见 §5) |
| `app/actions/procurement.ts` `addProcurementItem`(:292)、`syncFromProcurementTracking`(:408) | ⛔ 旧对账页入口,建 line **不挂 `procurement_item_id`** |
| `app/actions/trade-purchase.ts:174` | ⚠️ 贸易单成品大货,**显式** `procurement_item_id: null` —— 有意为之,不是 bug,但要登记 |

---

## 2. Canonical Truth Chain + `procurement_items` 裁定

### 2.1 链条

```
orders / order_line_items          需求(件数·套数·颜色·尺码)
   ↓
materials_bom                      BOM truth(跟单持有;含 consumption_basis)
   ↓ submitBomToProcurement
material_package_snapshots         冻结快照(版本化)
material_plans + material_requirements   系统算的需求(可重算投影)
   ↓ consolidate
procurement_items                  ★ 归并后的采购需求 + 采购决策
   ↓ generateExecutionLines
procurement_line_items             ★ 供应商执行行(canonical execution line)
   ↓ createPurchaseOrder
purchase_orders                    采购单头
```

### 2.2 裁定:两张表是**两个不同业务对象**,都保留

不是因为表已经存在,是因为它们的不变量不同,而且**基数就不同**。

| | `procurement_items` | `procurement_line_items` |
|---|---|---|
| 一行代表 | 本单内某**物料身份+色+单位**归并后的采购需求 | 向供应商下的**一条执行行** |
| 唯一键 | `UNIQUE(order_id, consolidation_key)` | 无唯一键,**一个 item 可裂成 N 行** |
| 生产实测 | 32 项 / 6 单 | 37 行 / 6 单(**1:1.16 扇出**) |
| 持有 | `production_consumption` `suggested/final_purchase_qty` `needs_reconfirm` `confirmed_source_snapshot` `status(draft→closed)` | `ordered_qty` `size` `received_qty` `purchase_order_id` `line_status` `ordered_amount`(生成列) |
| 语义 | **决策**:买多少、找谁、什么价、要不要替代 | **事实**:下了什么、到了多少、进了哪张 PO |

**扇出是真的**:`generateExecutionLines` 按 `size_qty_override` 把一个 item 拆成多行(`procurement-items.ts:1795-1801`),面料/散装恒单行。把两层压成一张表,要么丢掉"一次采购决策"这个对象,要么让决策字段在每个尺码行上重复 —— 那才是新造双真相。

**invariant**

- `procurement_items`:同 `(order_id, consolidation_key)` 至多一行;`status=confirmed` 才可生成执行行(`canGenerateExecution`);需求变动只置 `needs_reconfirm`,**不丢采购已填的决策**。
- `procurement_line_items`:每行必须可回指来源 —— `procurement_item_id`(原辅料)或显式登记的例外(贸易单);`ordered_qty` 落库后由收货/PO 侧演进,采购决策不再改它。

### 2.3 真正的双真相风险不在表,在**入口**

`procurement_line_items` 有 **4 个写入口,只有 1 个是 canonical**:

| 入口 | 位置 | 挂 `procurement_item_id`? | 判定 |
|---|---|---|---|
| `generateExecutionLines` | `procurement-items.ts:1812` | ✅ 由 `buildExecutionLineRow` 写入 | ✅ **canonical** |
| `addProcurementItem`(对账页手工录入) | `procurement.ts:292` | ❌ 无 | ⛔ Pilot 禁用 |
| `syncFromProcurementTracking` | `procurement.ts:408` | ❌ 无 | ⛔ Pilot 禁用(legacy 桥) |
| `createTradePurchase` | `trade-purchase.ts:174` | ⚠️ 显式 null | 登记例外,不走原辅料链 |

**这才是 Boundary Cut 最重要的一条结论**:保留两层没有代价,**四个入口才是代价**。P0 的收口目标不是合表,是让 Pilot 订单的执行行**只能**从 `procurement_items` 长出来。

---

## 3. ProcurementRepository Contract

按 capability 设计,不按表设计。**第一版只有 5 个方法**,内部涉及 8 张表是 Adapter 的事。

```ts
// lib/repositories/contracts/procurement.ts —— 只有签名与数据形状,零业务判断

export class RepositoryError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'permission' | 'io', message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** 归并所需的全部上游事实,一次取齐(避免 Application 里散着六个读) */
export interface ProcurementSource {
  order: { id: string; orderNo: string; quantity: number; factoryDate: string | null; etd: string | null };
  lineItems: Array<{ styleNo: string | null; colorCn: string | null; colorEn: string | null; qtyPcs: number; setMultiplier: number; sizes: Record<string, number> | null }>;
  bom: Array<{ id: string; materialName: string; materialCode: string | null; qtyPerPiece: number | null; unit: string | null; color: string | null; spec: string | null; styleNo: string | null; totalQty: number | null; consumptionBasis: string | null; materialMasterId: string | null }>;
  requirements: Array<{ id: string; bomId: string | null; materialKey: string; netPurchaseQty: number; requiredDate: string | null; version: number | null }>;
  planVersion: { planId: string | null; snapshotVersion: number | null };
}

export interface ProcurementDraft {
  items: Array<{
    id: string; orderId: string; consolidationKey: string; itemNo: string | null;
    materialName: string | null; specification: string | null; category: string | null;
    color: string | null; unit: string | null; materialMasterId: string | null;
    totalRequiredQty: number | null; sourceCount: number | null;
    developmentConsumption: number | null; productionConsumption: number | null;
    procurementLossPct: number | null; safetyStockQty: number | null;
    suggestedPurchaseQty: number | null; finalPurchaseQty: number | null;
    confirmedSupplierName: string | null; unitPrice: number | null; currency: string | null;
    leadDays: number | null; moq: number | null; purchaseUnit: string | null;
    sizeQtyOverride: Record<string, number> | null;
    needsReconfirm: boolean; status: string;
  }>;
  executionLines: Array<{ id: string; procurementItemId: string | null; size: string | null; orderedQty: number; lineStatus: string | null; purchaseOrderId: string | null }>;
}

/** Application 已经算好的落库意图 —— Repository 不再判断"该不该" */
export interface ProcurementDraftMutation {
  upsertItems?: Array<{ consolidationKey: string; fields: Record<string, unknown> }>;
  updateItems?: Array<{ id: string; fields: Record<string, unknown> }>;
  deleteItemIds?: string[];
  insertExecutionLines?: Array<Record<string, unknown>>;
}

export interface SupplierOption {
  id: string; name: string; category: string | null;
  defaultLeadDays: number | null; contact: string | null; isActive: boolean;
}

/** 供应商分组由 Domain 决定,这里只落库 */
export interface PurchaseOrderPlan {
  orders: Array<{ supplierId: string | null; supplierName: string | null; lineIds: string[]; currency: string | null; remark: string | null }>;
}

export interface ProcurementRepository {
  getOrderProcurementSource(orderId: string): Promise<ProcurementSource>;
  getProcurementDraft(orderId: string): Promise<ProcurementDraft>;
  saveProcurementDraft(orderId: string, mutation: ProcurementDraftMutation): Promise<{ upserted: number; updated: number; deleted: number; linesInserted: number }>;
  getSupplierOptions(filter?: { category?: string; activeOnly?: boolean }): Promise<SupplierOption[]>;
  createPurchaseOrders(orderId: string, plan: PurchaseOrderPlan): Promise<{ purchaseOrderIds: string[] }>;
}
```

**刻意不放进 contract 的东西**(留在 Domain/Application):

- `consolidationKey` 怎么算 → Domain 纯函数
- `suggestedPurchaseQty` 怎么算 → Domain(`orderableQty` 等已存在)
- `consumption_basis` 未确认要不要拦 → Domain `checkBasisReadiness` + Application 决定 `NEEDS_BOM_CONFIRMATION`
- 按供应商怎么分组 → Domain,产出 `PurchaseOrderPlan` 后才交给 Repository
- 谁能确认采购、审批链、财务同步、通知 → Application

以后 capability 长大再拆 `MaterialRequirementRepository` / `PurchaseOrderRepository`。**现在不提前抽象。**

---

## 4. Supabase Adapter Mapping

`lib/adapters/supabase/procurementAdapter.ts` —— 白名单内唯一碰表的文件。

| Contract 方法 | 读 | 写 | 备注 |
|---|---|---|---|
| `getOrderProcurementSource` | `orders` `order_line_items` `materials_bom` `material_requirements` `material_plans` | — | 一次取齐;并发 5 个 select,不做 N+1 |
| `getProcurementDraft` | `procurement_items` `procurement_line_items` | — | `select('*')` 保留(容忍 `size_qty_override` 列漂移) |
| `saveProcurementDraft` | — | `procurement_items` (upsert on `order_id,consolidation_key` / update / delete)、`procurement_line_items` (insert) | 执行行插入走 **service-role**(`size` 列只 GRANT SELECT,见 `procurement-items.ts:1804` 的历史坑) |
| `getSupplierOptions` | `suppliers`(必要时 `factories` 兼容) | — | `supplier_id` 外键曾指 `factories`,降级逻辑留在 Adapter |
| `createPurchaseOrders` | `purchase_orders`(取号) | `purchase_orders` insert、`procurement_line_items` update(`purchase_order_id`) | 挂行必须回读受影响行数 → 走 `lib/db/safe-mutation` |

**Adapter 硬规矩**

1. 所有 DB error 转 `RepositoryError`,**不把 PostgrestError 泄漏到上层**。
2. 高危写(挂 PO、删 item)走 `safeMutation`,回读行数 —— RLS 滤 0 行不报错([[lint:writes]] 的由来)。
3. 列漂移降级只允许在 Adapter 内,**不许把降级语义暴露给 Domain**。
4. 本轮 Adapter **零 migration**、零历史数据改写。

---

## 5. `procurement_tracking` Legacy Isolation Plan

**定性:LEGACY / READ-ONLY / NO NEW WRITES。本轮不删表、不迁 365 行。**

### 5.1 现存 writer 全清单(已查全)

| # | Writer | 位置 | 触发方式 | 本轮处置 |
|---|---|---|---|---|
| 1 | `initDefaultProcurementTrackingRows` | `procurement-tracking.ts:362`(insert :383) | **自动**:里程碑 `procurement_order_placed` 完成时(`milestones.ts:1078-1081`) | ⛔ **Pilot 订单跳过**;非 Pilot 保持 |
| 2 | 同上 | 同上 | **手动**:`ProcurementTrackingTab.tsx:102/112` 两处按钮 | ⛔ Pilot 隐藏入口 |
| 3 | `addProcurementTrackingRow` | `procurement-tracking.ts:131/134` | 手工加行 | ⛔ Pilot 禁用 |
| 4 | `submitSupplementRequest` | `procurement-tracking.ts:170` | 补料申请 | ⛔ Pilot 禁用(P1 走 `material-resupply`) |
| 5 | `approveSupplementRequest` | `procurement-tracking.ts:263` (update) | 补料审批 | ⛔ Pilot 禁用 |
| 6 | `updateProcurementTrackingRow` | `procurement-tracking.ts:328/332` | 编辑 | ⛔ Pilot 只读 |
| 7 | `deleteProcurementTrackingRow` | `procurement-tracking.ts:353` (delete) | 删行 | ⛔ Pilot 只读 |

**Reader(保留,不动)**:`order-financials.ts:52`(线下采购金额)、`procurement.ts:361`(`syncFromProcurementTracking` 读)、`orders/[id]/page.tsx:177`(折叠展示)。

### 5.2 停写方式

**不改 7 个函数的内部逻辑**,在文件顶部加一道 Pilot 守卫即可:

```ts
// app/actions/procurement-tracking.ts 顶部
async function assertLegacyWriteAllowed(orderId: string) {
  if (await isPilotOrder(orderId)) {
    throw new Error('LEGACY_TRACKING_WRITE_BLOCKED: 该订单已接入采购生成器,采购事实请走采购项/执行行');
  }
}
```

- **Pilot 订单**:7 个 writer 全部 fail-fast,`initDefault...` 静默跳过(不报错,避免卡住里程碑)。
- **非 Pilot 订单**:行为**完全不变** —— 本轮不改变历史订单行为,这是 CEO 明确要求。
- 里程碑钩子(`milestones.ts:1078`)加同一判断,Pilot 单不再自动插空壳行。

### 5.3 验收

- Pilot 单完成 `procurement_order_placed` 后,`procurement_tracking` **零新增行**;
- 非 Pilot 单行为与今天逐字节一致;
- 365 行历史数据原样保留,`order-financials` 的线下金额统计不受影响。

---

## 6. P0 First Vertical Slice

**目标:一张 Pilot 订单,从「BOM confirmed」自动变成「待采购 N 项」。到此为止。**

### 6.1 断点定位(本次代码核对的新发现)

Truth Map 说最大断点是"BOM 已提交"(−83%)。核对代码后发现**还有第二道人工门**,而且没人登记过:

```
submitBomToProcurement()   → 写 snapshot + material_plans + material_requirements
                           → ❌ 不调用 consolidateOrderProcurementItems
                           → 采购必须自己去 ProcurementItemsTab 点「归并」按钮
```

`consolidateOrderProcurementItems` 目前只有 4 个自动调用方,全在**改单**路径:
`order-amendments.ts:567/787`、`order-quantity-correction.ts:178/273`。
**主人工路径(BomTab 提交)一次都不调用。**

也就是说:即使跟单把 BOM 提交了,采购看到的仍是空的采购项列表,除非有人知道要去点那个按钮。这解释了为什么 ⑥ 之后的跳转"零流失"—— 能走到那一步的都是被人工推过去的。

### 6.2 切片范围

```
BomTab「提交采购」
   ↓  Application: SubmitBomCommand
Domain: checkBasisReadiness → 缺 basis 则 NEEDS_BOM_CONFIRMATION(不猜)
   ↓  Repository: getOrderProcurementSource
Domain: 需求计算 + 归并键 + suggested qty(全部纯函数)
   ↓  Repository: saveProcurementDraft(upsertItems)
采购中心出现「待采购 N 项」
```

**唯一新增行为**:`submitBomToProcurement` 成功后,对 **Pilot 订单**自动接一次归并。改单路径已经这么做了 —— 等于把已验证安全的调用补到主路径上,不是新机制。

### 6.3 明确不做

migration / 生产数据改写 / 历史 89 单迁移 / Material Readiness / Receiving / IQC / 供应商推荐 / AI 采购 / P2 / P3 / 把 14 个框减到 3 个(UI 优化排 P1)。

### 6.4 DoD

- [ ] Pilot 订单 BOM 提交后**无需任何额外点击**,采购中心出现待采购项
- [ ] `consumption_basis` 未确认 → 返回 `NEEDS_BOM_CONFIRMATION`,**草稿可生成但不得 Confirm**,绝不按物料名猜
- [ ] 非 Pilot 订单行为逐字节不变
- [ ] `procurement_tracking` 对 Pilot 单零新增行
- [ ] **新增业务层 direct DB access = 0**(`npm run lint:data-access` 绿,且基线**不涨**)
- [ ] Repository 内**零**业务判断(review 项,闸拦不住)

---

## 7. 留给 CEO 的三个待裁

1. **`trade-purchase.ts` 的 `procurement_item_id: null`** —— 贸易单成品大货绕开原辅料链是有意设计。是登记为**永久合法例外**,还是 P2 给它一个自己的 item 层?本轮按"登记例外"处理。
2. **`procurement_line_items.status` vs `line_status` 双状态列** —— Truth Map 已判定收口到 `line_status`、`status` 停写。本轮 Adapter 是否顺手**只写 `line_status`**?(不改历史行,只约束新写入)
3. **旧对账页两个入口**(`addProcurementItem` / `syncFromProcurementTracking`)对 **Pilot** 订单是禁用还是保留?建议禁用 —— 否则 Pilot 单会同时存在"有 item 的行"和"没 item 的行",P0 验收无法判定。
