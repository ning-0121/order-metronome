# QIMO OS — Object Relationship Map（对象关系图)

> Enterprise Architecture V1.0 核心章节。**Domain Map 说"谁负责";本图说"数据怎么流"**。
> 未来 AI / API / Workflow / Automation / Integration **全部围绕这张图**。优先级高于 Domain Map。
> **图例**:`(1)` 一 · `(N)` 多 · `→` 引用/产生 · `[域]` 拥有域 · ✅🟡⬜ 落地状态。

## 1. 主脊柱（订单到收款的对象流)
```
Customer [Customer] ✅
   │ (1:N)
   ▼
Order  [Order] ✅ ───(1:N)──▶ Order Line Item（款×色×码) [Order] ✅
   │ 引用 (N:M)
   ▼
Product [Product] ⬜ ───(1:1)──▶ Product BOM [Product] ⬜
   │ 实例化(每单)
   ▼
Material Package / materials_bom [Material] ✅   （开发单耗 qty_per_piece)
   │ 提交采购 + MRP
   ▼
Material Requirement [Procurement·系统] ✅   （每 BOM 行,可重算投影)
   │ 核料归并 (N:1,按物料身份+色+单位)
   ▼
Procurement Item / 采购核料项 [Procurement] ✅   （大货单耗 → 算量;采购确认)
   │ 确认 + 下单 (1:N 可拆单)
   ▼
Purchase Order / procurement_line_items [Procurement执行] 🟡
   │ 到料
   ▼
Receiving [Warehouse] ⬜ ──▶ Inventory [Warehouse] ⬜
                                   │ 领料
   ┌───────────────────────────────┘
   ▼
Production [Production] 🟡 ◀──(消费)── Manufacturing Order/生产任务单 [MP] ✅
   │ 完工
   ▼
Quality（IQC/IPQC/FQC/OQC) [Quality] 🟡
   │ 合格
   ▼
Packing [Packing] ⬜
   │ 装箱完成
   ▼
Shipment [Shipment] 🟡
   │ 出运
   ▼
Invoice [Finance] 🟡 ──▶ Payment [Finance] 🟡
```

## 2. 关键关系(基数 + 引用)
| 上游 | 关系 | 下游 | 引用方式 |
|---|---|---|---|
| Customer | 1:N | Order | `orders.customer_*` |
| Order | 1:N | Order Line Item | `order_line_items.order_id` |
| Order | N:M | Product | 引用款(未来 order_line_items.product_id)|
| Product | 1:1 | Product BOM | 款的物料模板 |
| Product BOM | 实例化 | Material Package | 每单 BOM(未来挂 product/line_item)|
| Material Package | 1:N(提交+MRP)| Material Requirement | `material_requirements.snapshot_line_id` |
| Material Requirement | **N:1(核料)** | **Procurement Item** | live 按 `consolidation_key` peg(不锚易失 id)|
| Procurement Item | 1:N(拆单)| Purchase Order | `procurement_line_items.procurement_item_id`(P2)|
| Purchase Order | 1:N | Receiving | 到料 |
| Receiving | N:1 | Inventory | 入库 |
| Order+Product+Material | →生成 | Manufacturing Order | `manufacturing_orders.order_id`(1:1)|
| Manufacturing Order + Inventory | →消费 | Production | 领料生产 |
| Production | →产出 | Quality → Packing → Shipment | 完工→质检→装箱→出运 |
| Shipment | →触发 | Invoice → Payment | 结算 |

## 3. 跨订单可复用对象(被引用,不被订单拥有)
- **Product(款)**、**Material Master**、**Supplier** —— 跨订单复用;Order/Package/PO 只引用它们。
- 这是"引用不复制"(Constitution 02)的物理体现:同一个款/料/供应商,多订单共享一份真相。

## 4. 现状 vs 缺口(诚实)
- ✅ 已贯通:Customer→Order→Material Package→Material Requirement→**Procurement Item**;Order→Manufacturing Order。
- ⬜ 缺口:**Product 对象未独立**(款/BOM 散在 line_items/materials_bom)→ 这是 Product Domain 要补的;Receiving/Inventory/Packing/Invoice/Payment 未建。
- **P1′ 已知限制**:Procurement Item 来源明细只到物料行,未到产品(因 materials_bom 未挂 product/line_item)→ Product Domain 起步后填补。

> 这张图一旦稳定,新增任何对象都先回答:它**插在这条链的哪一环**?上游是谁、下游是谁、引用还是拥有?(配合 DoD 的 Architecture Gate)
