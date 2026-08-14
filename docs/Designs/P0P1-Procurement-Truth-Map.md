# Procurement Generator P0+P1 — Truth Map

> Phase A 交付物。基于 2026-08-13 真实生产 schema + 数据核对,不依赖记忆。
> CEO 拍板:P0+P1 一起做,产品对象是 **Procurement Mission**,不是采购申请表。

---

## 1. Canonical Truth 判定

| 对象 | Canonical 表 | 现状 | 判定 |
|---|---|---|---|
| Order truth | `orders` + `order_line_items` | 现成 | 不动 |
| BOM truth | `materials_bom` (185 行/36 单) | 现成 | 不动 |
| Material Requirement truth | `material_requirements` (58 行/6 单) | 现成 | 不动 |
| Procurement Draft truth | `procurement_items` (32 项/6 单) | 现成 | 不动 |
| Purchase Order truth(头) | `purchase_orders` (4 张) | 现成 | 不动 |
| **Purchase Order Line truth** | **`procurement_line_items` (37 行)** | 现成 | ✅ **唯一 canonical** |
| ~~采购跟踪~~ | `procurement_tracking` (365 行) | 空壳 | ⛔ **legacy,停写 + 只读** |

### 为什么 canonical line = `procurement_line_items`

不是偏好,是 schema 已经这样长了:

- **已有回指全部上游的外键**:`requirement_id` → material_requirements、`procurement_item_id` → procurement_items、`purchase_order_id` → purchase_orders、`legacy_tracking_id` → procurement_tracking
- **已有 CEO 要求的全部 PO 事实字段**:`po_no` `supplier_id` `supplier_name` `ordered_qty` `ordered_unit` `unit_price` `ordered_amount` `required_by` `promised_date`(=供应商承诺交期)`ordered_by`(=buyer)`ordered_at` `status`
- **已有 P3 收货字段**(本轮不做,但不用改表):`received_qty` `received_at` `received_by` `expected_arrival`
- `exportPurchaseOrder()` 已经在读它出 Excel

→ 无需新建表。本轮**零 migration**(除非补 CHECK/索引)。

### 为什么 `procurement_tracking` 是 legacy 而不是真相

它是行数最多的表(365),很容易被误当成"大家其实在用的采购跟踪"。数据说不是:

```
status          : 100% pending      (365/365)
supplier        : 0 行有值
order_date      : 0 行有值
expected_arrival: 0 行有值
actual_arrival  : 0 行有值
amount          : 0 行有值
```

它由 `initDefaultProcurementTrackingRows()` 在建单时自动插空壳(每单 fabric/trims/packaging 各一行,91 单 ≈ 365 行),近 30 天还在增长 76 行。**它是占位符,不是事实。**

→ 本轮处置:**停止新建**,现有行保留只读,不双写。禁止任何新代码写它。

---

## 2. 唯一闭环(本轮范围)

```
Order → Line Items → BOM → Material Requirement
      → Procurement Draft → Supplier / Price / Commit Date
      → Confirm Purchase → Supplier-grouped PO → Excel / PDF
```

**到此停止。** 不做:收货 / IQC / Material Readiness / 供应商推荐 / 供应商评分 / AI采购 / 历史 89 单迁移 / 全采购部上线。

---

## 3. 实测漏斗 —— 断点不在我们以为的地方

| 跳 | 订单数 | 流失 |
|---|---|---|
| ① 有 BOM | **36** | — |
| ② BOM 已提交 | **6** | **−83% ⛔ 最大断点** |
| ③ 生成 material_requirements | 6 | 0 |
| ④ 生成 procurement_items | 6(32 项) | 0 |
| ⑤ 生成执行行 | 6(37 行) | 0 |
| ⑥ 正式 PO | 4 张(3 placed / 1 draft) | — |

**关键结论:采购链的代码是通的,断的是第一跳。** 128 条系统已自动算好的 BOM 行长期躺在 draft —— 提交这一步要么找不到、要么提交了没回报。

所以 P0 的第一优先级不是"把 14 个框减到 3 个",而是 **让 BOM 一确认就自动出现待采购需求,不需要人去找「提交」按钮**。

### 其余实测缺口

| 缺口 | 数据 | 本轮处置 |
|---|---|---|
| **供应商承诺交期从未被采集** | `promised_date` **0/37** | P1 一等字段,必填 |
| 执行行双状态列 | `status` 全 null,只用 `line_status` | 收口到 `line_status`,`status` 停写 |
| 物料主数据没有默认供应商 | 0/43 有 `default_supplier_name` | P1 确认时回写(为 P2 攒记忆,不做推荐) |
| BOM 不引用主数据 | 26/185 | 不强制,但确认时尽量落 `material_master_id` |
| consumption_basis 空 | 182/185 | Pilot 遇空**不猜**,要求确认一次并保存 |

---

## 4. 需求量的唯一计算口径

由 `consumption_basis` 驱动,不由"是不是套装"驱动(2026-08-12 已立为 domain invariant):

| basis | 乘数 |
|---|---|
| `PER_SET` | commercial quantity(套数) |
| `PER_PIECE` | physical quantity(件数) |
| `PER_COMPONENT` | component quantity |
| `PER_ORDER` | 固定量,不乘 |
| 空 / UNKNOWN | **不猜** → 弹一次确认,结果落库,下单可复用 |

计算入口统一走 `lib/domain/line-item-quantity.ts`,受静态闸 `lint:qty` 保护。

---

## 5. 反第二真相源的三条硬规矩

1. **`Calculated Required Qty` 采购不可直接改。** 只能点「需求有误」→ 退回 BOM/订单事实层修正 → 重新生成。
2. **`procurement_tracking` 停写。** 任何新代码不得 insert/update 它。
3. **「导出 Excel」不等于采购完成。** 事实先落 `purchase_orders` + `procurement_line_items`,Excel/PDF 只是这些事实的渲染输出。

---

## 6. 已存在、可直接复用的代码(不重写)

| 能力 | 位置 | 状态 |
|---|---|---|
| BOM → Requirement → Draft 归并 | `app/actions/bom.ts` / `consolidateOrderProcurementItems()` | 可用 |
| Draft → 执行行 | `generateExecutionLines()` | 可用 |
| 建 PO(按供应商) | `createPurchaseOrder()` | 可用 |
| PO 导出 Excel(含价/无价两版、带图、按颜色分行) | `exportPurchaseOrder()` | **已相当成熟** |
| 采购角色门禁 | `requireProcurementRole()` | 可用 |

→ **P0+P1 主要是"接线 + 收口 + 补两个字段",不是从零造。** 这直接影响工期估计,如实上报。

---

## 7. Phase B / C 待建清单

**Phase B(P0 · Zero Duplicate Input)**
- BOM 确认后**自动**产生待采购需求(去掉"去找提交按钮"这一跳)
- 采购页默认视图 = 「待采购 N 项」,不是「新增采购申请」
- 系统已知字段全部只读:Order / Style / Color / Material / Spec / Basis / 单耗 / 需求量 / 单位 / 要求到货日
- 采购只可填 3 项:**Supplier · Unit Price · Supplier Commit Date**
- 「需求有误」clarification 通道(退回事实层,不在采购层改数)

**Phase C(P1 · Confirm Purchase)**
- 「确认采购」→ 按 supplier 自动分组 → 生成正式 PO(头 + canonical line)
- `promised_date` 落库(当前 0/37)
- 确认时写 learning data:material / supplier / price / currency / purchase_date / commit_date / buyer
- 输出:Printable View + Excel(已有)+ PDF(待补)

**Pilot**:3–5 张新 EHL 单,1 名跟单 + 1 名采购。非 Pilot 订单行为不变。

**验收(先测旧流程 baseline)**:重复输入=0 · 手工算需求量=0 次 · 采购填写≤3 类 · 手工重做 Excel=0 次 · BOM→正式 PO 人工操作<5 分钟 · **员工愿意直接把系统生成的采购单发给供应商**(否则 P1 = FAIL)。
