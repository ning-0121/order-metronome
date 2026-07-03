# 库存域(Inventory Domain)蓝图 V1.0

> 2026-07-03。状态:现状盘点 + 绑定关系 + 分期。遵循 ADR-005(DB 存事实·内核算真相)、Constitution 02(单一真相源)。
> 结论先行:库存的**动作能力已基本齐全**(收货入库/领料/退料/尾货/预留/可用量都有);缺的是**绑定进日常界面**和**呈现成一个中心**。本文把散件盘清、画出绑定图、定分期。

## 〇、铁律(不可协商)

1. **流水是唯一真相,余额永远派生**。`inventory_transactions` append-only(触发器挡 UPDATE/DELETE),余额 = Σqty,从不落库存字段。纠错 = 写反向流水,不改历史。
2. **全域同一把 key**:库存 `material_key` = 采购 `consolidation_key`(物料身份+颜色+单位)。收货、领料、尾货、核销必须同口径,否则对不上账。
3. **可用量只有一个算法**:`可用 = 在库 − 预留 − 安全库存`(`getAvailableStock`/SC-P2)。任何地方要"能不能用这批料"都调它,不另算。
4. **人录真相,系统不臆造**:领料、盘点、报废靠人真实录入;系统只做入库自动化(收货→入库)和派生计算。

## 一、现状盘点(已建成的地基)

| 能力 | 实现 | 状态 |
|---|---|---|
| 流水账 | `inventory_transactions`(receipt/issue/return/adjust/scrap;qty 带符号;append-only 触发器) | ✅ W0 |
| 派生余额 | `aggregateInventoryBalance` → 在库/预留/可用/缺口 | ✅ |
| **收货自动入库** | `recordReceiptBatch` → `recordInventoryReceipt`(增量 delta,收多少入多少) | ✅ 绑定已通 |
| 领料 / 退料 | `recordInventoryIssue`(−)/`recordInventoryReturn`(+),`CAN_ISSUE_MATERIAL` 门控,可挂订单 | ✅ W1 |
| 尾货清点归库 | `recordLeftoverStocktake`(出货后实物余料入库) | ✅ |
| 库存预留 | `inventory_reservation` + `reserveStock`/`releaseReservation`/`consumeReservation` | ✅ SC-P2 |
| 可用量(预留感知) | `getAvailableStock` = 在库−预留−安全库存 | ✅ |
| 库存中心页 | `/procurement/inventory`:余额表(在库/预留/可用/缺口)+ 领料/退料 + 逐物料流水明细 | ✅(2026-07-03 修复 import 崩溃后可用) |
| 多库位 | `location` 列 + `listWarehouses`(**留位,未落地**) | ⚠ 骨架 |
| 盘点 / 报废 | 流水已有 `adjust`/`scrap` 类型(**无录入 UI**) | ⚠ 类型在,入口缺 |

## 二、绑定关系(库存怎么和业务咬合)

```
【入】采购收货 goods_receipts ──recordInventoryReceipt(增量)──▶ receipt (+)
【出】生产领料 manufacturing_order ──recordInventoryIssue────────▶ issue (−)  [挂 order_id]
【回】退料 ─────────────────────────recordInventoryReturn───────▶ return (+)
【余】出货后尾料清点 ──────────────recordLeftoverStocktake──────▶ 归库 (+)
【调】账实盘点差异 ────────────────(adjust,入口待建)────────────▶ adjust (±)
【损】破损报废 ────────────────────(scrap,入口待建)─────────────▶ scrap (−)
                                                     │
                                        Σqty 按 material_key 派生
                                                     ▼
                                在库 on_hand · 预留 reserved · 可用 available · 缺口 shortage
```

**两个维度看库存**:
- **物料维度**(库存中心):每种料现在有多少、能用多少、哪些负库存/缺口 → 采购/仓库看。
- **订单维度**(订单核料页 fulfillment):这单每料 需求/下单/收货/消耗/尾货 → 已有 `getOrderProcurementFulfillment`,核料页「执行/核销进度」表已呈现。

**核销闭环**:领料挂 `order_id` → 订单维度的"消耗"= 该单领料流水 Σ;"尾货"= 收货 − 消耗;出货后清点归库把实物尾料转成可复用库存,下次采购同料自动抵扣(`getAvailableStockByKeys` 已接进核料页)。

## 三、缺口与分期

- **W-P1 库存中心成型**(本轮起步):修复库存页崩溃 ✅;顶部汇总卡(物料种数/负库存/需补货)+ 搜索;采购中心「📦 库存」入口计数。让它从"一张扁平表"变成能一眼看健康度的中心。
- **W-P2 盘点 + 报废入口**:`adjust`(账实差异一键校准,写差额流水留痕)/`scrap`(破损报废)录入 UI —— 类型早在流水里,只差入口。仓库月度盘点靠这个对账。
- **W-P3 多库位落地**:收货选入哪个库位、按库位查余额、库位间调拨(`location` 列 + `listWarehouses` 已备)。一个仓不够用时启用。
- **W-P4 移动加权成本**:每次入库更新该料加权单价 → 领料成本、尾货估值,喂财务决算(现在库存只有量、没有值)。
- **W-P5 低库存预警 + 采购联动**:`可用 < 安全库存` → 预警 + 一键发起补采购(接补采购机制)。常备辅料(线/标准拉链)自动提醒补货。
- **绑定深化**:①物料库列表显示"当前库存"列(需按 master_id 聚合各颜色 key,口径要谨慎);②订单详情「库存」视角(这单收/领/尾一屏)。

## 四、对象准入(双门禁回顾)

- 🏛 **Architecture Gate**:库存自成一域(与物料域/采购域平级);数据所有权=仓库+采购+生产共写(各写各的流水类型);**无重复真相**——余额永远派生,不与任何表并行存量。
- 🔮 **Future Gate**:append-only 流水面向十年可审计;多库位/成本/批次都是加列或加流水类型,不重构;key 全域统一保证跨域对账在 10 工厂规模仍成立。

## 五、明确不做

余额落库字段 ✗ · 改历史流水纠错 ✗(走反向流水)· 库存 key 另立一套 ✗(必须 = consolidation_key)· 可用量在 UI 自算 ✗(只调 getAvailableStock)· 系统替人臆造领料/盘点数 ✗。
