# SCM OS Completion Blueprint V1 — 供应链操作系统「补缺」蓝图

> **层**: Design(阶段实施方案). **性质**: 设计蓝图,**非可执行 SQL**. 本文 DDL 是规格;每阶段真正上库的 migration 单独成文件,先审 diff → 你执行 → DB 门禁验证。
> **铁律**: 只补缺、纯加法、不重设计既有表、不动 Order/Quote/PO 核心逻辑、不造平行真相、共享 OS 能力模型做鉴权。
> **前提真相(不重造)**: `material_master`(物料真相) · `inventory_transactions`(库存真相,append-only) · `orders`/`material_requirements`(需求真相) · `procurement_items`/`procurement_line_items`(采购归并+执行) · `OSDecisionKernel`+`lib/os/capabilities.ts`(能力/鉴权). 依据 ADR-002(需求脊柱)/ ADR-004(采购五层).

---

## A. System Reality Map(现状 vs 缺口)

| 层 | 已有(真相,不动) | 缺口(本蓝图补,纯加法) |
|---|---|---|
| **物料 Material** | `material_master`(code/name/category/default_unit/default_consumption/default_supplier_name/default_lead_days/spec/loss_rate/临时物料转正) · `materials_bom.material_master_id` · `consolidationKey()` · products/variants/bom_templates | ①物料↔多供应商图 ②单位换算 ③替代物料关系 ④物料级安全库存/再订货点 |
| **库存 Inventory** | `inventory_transactions`(append-only:receipt/issue/return/adjust/scrap,signed qty,order_id,source_ref,**location 列已存在但未用**) · 派生余额 · 收货自动入库 · 尾货 | ⑤预留/占用库存 ⑥可用量 available=on_hand−reserved−safety ⑦仓库维度激活(写 location) |
| **采购智能 Procurement** | 时间分段可解释 MRP `computeMaterialRequirement`→`material_requirements` · 归并 `procurement_items`+`computeSuggestedPurchaseQty` · 跨单 netting · B3a `generateExecutionLines` | ⑧补货引擎(min/max·安全库存,库存驱动) ⑨供应商打分(价/期/履约) ⑩断料预测(run-out) |
| **执行桥 Bridge** | Quote→PO→Order · Order→消耗→库存→采购(W0–W3+B3a) · 溯源 origin_quote_id→PO→order→procurement_item_id→source_ref · Kernel/IntakeRouter | ⑪领料单(仓库出库单据) ⑫下单确认即预留 ⑬全链路溯源视图 |

**结论**: 脊柱/账本/MRP/桥已在产。真建 = 上表 13 个加法项,零重写、零双真相。

---

## B. Minimal Additive Data Model(仅新增,蓝图 DDL)

> 既有表**一列不改**(除 4 个纯加列)。以下为规格;真 migration 另附验证 SQL + 回滚。

```sql
-- 【GAP1 物料完整】
CREATE TABLE public.material_supplier (          -- 物料↔多供应商(价/期/MOQ/优先)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  unit_price numeric, currency text DEFAULT 'CNY', lead_days int, moq numeric, purchase_unit text,
  is_preferred boolean NOT NULL DEFAULT false, last_quoted_at date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_master_id, supplier_id));

CREATE TABLE public.material_uom (               -- 单位换算(1 from = factor to)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  from_unit text NOT NULL, to_unit text NOT NULL, factor numeric NOT NULL CHECK (factor > 0),
  UNIQUE (material_master_id, from_unit, to_unit));

CREATE TABLE public.material_alternative (       -- 替代/等效物料图
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  alt_material_master_id uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('equivalent','substitute','upgrade')),
  ratio numeric NOT NULL DEFAULT 1, note text,
  CHECK (material_master_id <> alt_material_master_id),
  UNIQUE (material_master_id, alt_material_master_id));

ALTER TABLE public.material_master               -- 物料级安全库存/再订货点 + 类别层级
  ADD COLUMN IF NOT EXISTS parent_category_id uuid REFERENCES public.material_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS safety_stock_qty numeric,
  ADD COLUMN IF NOT EXISTS reorder_point numeric,
  ADD COLUMN IF NOT EXISTS max_stock numeric;

-- 【GAP2 库存正确性】
CREATE TABLE public.warehouse (                  -- 激活既有 inventory_transactions.location
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active');

CREATE TABLE public.inventory_reservation (      -- 预留账(可变状态;非流水,故独立于 append-only 账本)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_key text NOT NULL,                     -- 复用 consolidationKey,与 inventory_transactions 同口径
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  qty numeric NOT NULL CHECK (qty > 0), location text,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','consumed')),
  source_ref uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz);
CREATE INDEX ix_resv_key_status ON public.inventory_reservation(material_key, status);

-- 【GAP4 执行桥:领料单】
CREATE TABLE public.stock_issue_sheet (          -- 出库/领料单(单据头);posting 时生成 inventory_transactions(issue)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_no text UNIQUE, order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  warehouse_id uuid REFERENCES public.warehouse(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','picked','issued','cancelled')),
  requested_by uuid, issued_by uuid, issued_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.stock_issue_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES public.stock_issue_sheet(id) ON DELETE CASCADE,
  material_key text NOT NULL, material_master_id uuid REFERENCES public.material_master(id),
  qty numeric NOT NULL, unit text, issued_qty numeric,
  inventory_txn_id uuid);                         -- posting 后回填生成的流水 id(单据↔账本对账)

-- 【GAP3 采购智能:库存级补货建议;订单驱动 MRP 仍在 material_requirements,不重复】
CREATE TABLE public.replenishment_suggestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  warehouse_id uuid REFERENCES public.warehouse(id) ON DELETE SET NULL,
  on_hand numeric, reserved numeric, available numeric, reorder_point numeric,
  suggested_qty numeric, suggested_supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  reason jsonb,                                   -- explainable(仿 MRP explain_json)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','drafted','dismissed')),
  computed_at timestamptz NOT NULL DEFAULT now());
-- 全部表:RLS ENABLE + select/insert/update policy(auth.uid() IS NOT NULL;写权在 action 层按能力把关)
```

**"采购推荐表" = 既有 `material_requirements`**(订单驱动 MRP 投影),不新建;`replenishment_suggestion` 只补 MRP 不管的**库存 min/max 补货**。

---

## C. Core Logic(纯函数,确定性可测)

放 `lib/services/`,纯逻辑,单测入 `npm run check`(同 mrp.ts/inventory.ts 惯例)。

```ts
// 1) 可用量(ATP). 账=Σledger;预留=Σreservation(reserved). available 可为负(超卖信号)。
availableToPromise({ onHand, reserved, safetyStock, inboundOpenPO=0 }): number
  = round3(onHand + inboundOpenPO - reserved - (safetyStock ?? 0))
onHand(txns, {location?}) = Σ txns.qty[location?]        // 复用 aggregateInventoryBalance,加 location 分组
reservedQty(reservations) = Σ r.qty where r.status==='reserved'

// 2) 预留(下单确认触发;纯计算返回要写的预留行,写库在 action)
buildReservations(orderId, bomLines): {material_key, qty, order_id}[]  // 按 BOM×数量,consolidationKey 归并

// 3) 补货建议(库存驱动 min/max). available < reorder_point → 补到 max,向上取整 MOQ。
suggestReplenishment({ available, reorderPoint, maxStock, moq }): { suggested_qty, triggered }
  triggered = available < reorderPoint
  raw = (maxStock ?? reorderPoint) - available
  suggested_qty = triggered ? ceilToMoq(max(0, raw), moq) : 0

// 4) 供应商打分(价/期/履约,加权,可解释;只建议不自动下单 DP-4)
scoreSupplier(rows: MaterialSupplier[], weights={price,lead,perf}, perf): Scored[]
  score = w.price*norm(1/unit_price) + w.lead*norm(1/lead_days) + w.perf*(perf.onTimeRate ?? 0.5)
  → argmax;返回排序 + 每项归一分(reason)
```
全部无副作用、不读 DB;喂数据由 action 拉,便于单测。

---

## D. API Layer(Next.js Server Actions,仅新增,显式过能力闸)

鉴权**共享 kernel 能力模型**:`lib/os/capabilities.ts` 加 `material.manage / inventory.manage / replenishment.view / warehouse.manage`;action 内 `capabilitiesForRoles(roles).includes(cap)` —— 与 `OSDecisionKernel` 读同一份能力,鉴权不分叉。

| Action | 能力 | 作用 | 依赖既有 |
|---|---|---|---|
| `reserveStock(orderId)` | inventory.manage | 按 BOM 建 `inventory_reservation`(fire-and-forget,同 B3a 钩子) | orders/materials_bom |
| `releaseReservation(orderId\|id)` | inventory.manage | 预留→released | |
| `getAvailability(materialKey, wh?)` | inventory.view | 派生 onHand/reserved/available | inventory_transactions |
| `computeReplenishment(wh?)` | replenishment.view | 扫 material_master(reorder_point)→写 `replenishment_suggestion` | material_master |
| `suggestSupplier(materialMasterId)` | replenishment.view | 读 `material_supplier`→`scoreSupplier` | suppliers |
| `draftPOFromSuggestions(ids[])` | procurement.manage | 建议→既有 `procurement_line_items`/`purchase_orders`(挂 procurement_item_id) | B3a/P1 |
| `createIssueSheet(orderId)` / `postIssueSheet(sheetId)` | inventory.manage | 领料单头/行;post→生成 `inventory_transactions(issue)` + 预留→consumed | inventory W1 |

---

## E. Integration Rules(精确挂点,不重实现既有流)

- **OrderIntakeRouter / createOrder**: 建单成功后 fire-and-forget `reserveStock(orderId)`(与 B3a 状态钩子同模式);**不改** createOrder。
- **PO 系统**: `draftPOFromSuggestions` 喂**既有** `purchase_orders`+`procurement_line_items`(带 `procurement_item_id`,B3a 口径);不新建采购单对象。
- **procurement_items**: `material_supplier`+`scoreSupplier` 插入既有采购项**确认流**(填 confirmed_supplier/price 时给建议);不改归并逻辑。
- **inventory_transactions**: 预留、领料单是**账本之上的层**;账本仍是唯一真相,领料单 post **生成**流水(不旁路)。`location` 从此写入 → 仓库维度免费激活。
- **material_requirements**: 订单驱动 MRP 不动;`replenishment_suggestion` 只补库存 min/max,二者按来源分工(reason 标注),不双轨。

---

## F. Execution Phasing(严格顺序,每阶段=加法 migration + 纯逻辑 + 薄 action + 一处 UI)

| 阶段 | DB(纯加) | API | UI 触点 | 依赖 |
|---|---|---|---|---|
| **P1 物料 OS 完整** | material_supplier · material_uom · material_alternative · material_master(+4列) | upsertMaterialSupplier · convertUnit · listAlternatives · setSafetyStock | 物料主数据详情:供应商/换算/替代/安全库存 | 无 |
| **P2 库存预留层** | warehouse · inventory_reservation ·(开始写 location) | reserveStock · releaseReservation · getAvailability · listWarehouses | 库存看板:可用/预留/安全 列 + 仓库筛选 | 无(可与 P1 并行) |
| **P3 采购智能层** | replenishment_suggestion | computeReplenishment · suggestSupplier · draftPOFromSuggestions | 采购中心:补货建议 + 断料预警 + 供应商推荐 | **依赖 P1(供应商图)+ P2(available)** |
| **P4 执行桥完整** | stock_issue_sheet(+line) | createIssueSheet · postIssueSheet | 订单页领料单 + 全链路溯源视图 | **依赖 P2(预留)** |

**依赖顺序铁律**: P3 必须在 P1+P2 之后(供应商打分要 material_supplier,补货要 available);P4 依赖 P2 预留。P1、P2 可并行起步。

**每阶段执行纪律**: 我写该阶段 migration(完整+幂等+RLS+验证+回滚)→ 你审 diff → 你在 SQL Editor 执行 → 跑 DB 门禁 → PASS → 纯逻辑+action+UI → build/check → diff → 你批 → push。**一次一阶段,不跳步。**
