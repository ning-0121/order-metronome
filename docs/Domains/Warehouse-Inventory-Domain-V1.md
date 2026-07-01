# 库存 · 生产消耗域设计 V1（Warehouse Inventory & Material Issue）

> **Date**: 2026-07-02 · **Domain 设计**（长期）。采购"收了多少" ↔ 生产"用了多少"之间缺的一环;真尾货 = 采购 − 实际消耗,本域=**"实际消耗"的采集与真相**。顺带补 v2.1 MRP"扣库存=0"缺口。
> **不写代码 / migration / DB。** 落地按分期(W0→W3),每期单独走 计划→批准→编码。

## 0. 目标
`采购收货 → 入库 → 领料 → 消耗/退料 → 尾货`,每步留痕、可追、可对账;真尾货由它派生。

## 1. 对象准入双门禁
- **🏛 Architecture Gate**:属仓库/供应链域;owner=仓库。**无双真相**——采购拥有"收了多少",库存拥有"库里有多少 + 领了多少"(不同事实,引用不复制);生产任务单 O2 引用领料,不自存料量。
- **🔮 Future Gate**:库存+领料是供应链核心,3年/10工厂/多库位成立 → **准入通过**。

## 2. 对象模型（append-only 账本 + 派生余额，复用 Runtime 哲学）
### `inventory_transactions`（库存流水 · 唯一真相 · append-only）
`id · material_key(复用 consolidation_key) · material_name · unit · txn_type(receipt入库/issue领料/return退料/adjust盘点/scrap报废) · qty(带符号) · order_id(领料/退料挂单,可空) · source_ref(入库→procurement_line_item_id;领料→manufacturing_order_id) · location(可空) · created_by · created_at · note`
—— **永不 update/delete;纠错=反向流水**(同 runtime_events)。

### `warehouse_inventory`（库存余额 · 派生投影）
`material_key · location · on_hand_qty(=Σ流水) · unit · updated_at`
—— v1 **纯派生**(读时算 Σ);高频后可做维护式投影(像 runtime_orders)。

> 领料单:v1 = 一组 issue 流水挂 order_id/manufacturing_order_id,不另建头;要审批/批量再加领料单头。

## 3. 数据流 + 采集点（谁在哪录）
```
采购收货(现有 recordGoodsReceipt) ──自动──▶ receipt 流水(入库,+)      ← 钩子,自动
生产/仓库为订单领料 ──手动──▶ issue 流水(领料,−,挂 order_id)          ← 【消耗采集核心】
生产结束退料 ──手动──▶ return 流水(退料,+)
盘点 ──手动──▶ adjust 流水
```
- 入库=自动(收货即入库)。领料/退料=人工(仓库/生产录)=实际消耗来源。
- 消耗(order) = Σ issue − Σ return(该订单)。

## 4. 真尾货（派生，不存）
`真尾货(order) = 采购 received(该单物料) − 实际消耗(issue − return)` = 买了没用掉的料(退回库存 + 多买没领)。订单完成(lifecycle=completed)结算/展示。

## 5. 与现有连接（Evolution）
- `procurement_line_items.received_qty` → 入库 receipt 流水(source_ref)。
- `material_requirements.requirement_id` → 领料核销需求(可选接线)。
- `manufacturing_orders`(O2) → 领料挂生产任务单。
- **补 v2.1 MRP 缺口**:`warehouse_inventory.on_hand` → 喂 MRP `inventory_deduct`(现=0)→ 净采购量自动扣库存(W3)。
- `order_cost_baseline.actual_fabric_used_kg` → 与领料消耗对账(两口径,非替代)。

## 6. 分权
仓库(入库/领料/退料/盘点)· 生产(领料/退料)· 采购(只读库存/尾货)· 财务(只读料成本)· 业务(只读料齐/尾货,不看成本)。

## 7. 铁律
append-only 流水=真相 · 余额=派生 · **人工录领料(AI 不自动发料/不扣)** · 纠错走反向流水不改历史 · 库存唯一真相(采购/生产引用不复制)。

## 8. 分期
| 期 | 内容 |
|---|---|
| **W0** | `inventory_transactions`(对象)+ **入库自动钩子**(收货→receipt)+ 派生余额读 |
| **W1** | 领料/退料 UI(仓库/生产录 issue/return)= 消耗采集 |
| **W2** | 真尾货派生(received − consumed per order)+ 结算报表(替换 P4 订收差异占位) |
| **W3** | 库存看板 + MRP 扣库存(补 v2.1)+ 领料核销 requirement |

## 9. 残余 / 硬依赖（诚实）
- **值全靠人真录领料**:不录 issue/return → 消耗=0、尾货=received(全错)。W1 采集须配操作规范。
- "准备建库" → 本域是该库数据核心;库的实体流程(收货入库/发料/盘点)与本模型一起设计,别脱节。
- 多库位/批次/保质期 = 后续(location 已留位)。

---
> 本文 = 库存·消耗域设计。落地分期,每期 计划→批准→编码;migration 手动执行 + DB 门禁。
