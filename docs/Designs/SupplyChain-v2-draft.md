# QIMO OS — Supply Chain Domain Architecture v2.0

> 状态:**待审批**(只出架构与实施方案,不写代码)
> 日期:2026-06-28 · 作者:架构审核员(Claude)
> 取代:`docs/procurement-flow-design.md` 里"采购按 Excel 汇总"的口径。Step A(业务提交原辅料单)已上线,本文重定义其下游。

---

## 0. 第一性原理(整个供应链域的地基)

> **系统负责"计算",采购负责"决策"。**
> **采购中心管「订单」,采购计划管「物料」。**

- 采购部门**不是录入部门,是决策部门**。
- 采购**永不**重复加总、拆数量、合并 Excel、重算 BOM。
- 对象层级从「一堆物料」改为:**订单 → 采购计划 → 采购明细**。
- Helen 早上想的是"**今天哪些订单要完成**",不是"我要买条拉链"。所以**采购中心首屏 = 订单,不是物料**。
- **没有共享 Excel**:Excel 会分裂出业务版/采购版/财务版/管理版,最终没有唯一真相源。**QIMO OS 自己就是唯一真相源。**

### 数据归属(各管各的,不重复维护)
| 部门 | 拥有的数据 | 落在哪张表 |
|---|---|---|
| 业务 | 物料定义 / 单耗 / 规格 / 物料包 | `materials_bom` |
| 采购 | 供应商 / 价格 / 询价 / 采购 / 收货 / 验货 | `procurement_line_items` · 🆕`supplier_quotes` · `goods_receipts` |
| 仓库 | 库存 / 库位 / 发料 / 余料 | 🆕`warehouse_inventory` · 🆕`leftover_inventory`(Phase 2) |
| 生产 | 实际消耗 / 补料 / 退料 | `production_reports` · `procurement_line_items`(补料标记) |
| 财务 | 成本 / 付款 / 供应商信用 / 利润 | `order_cost_baseline` · `order_financials` |

---

## 1. New UI Architecture(新 UI 架构)

```
采购中心首屏  =  订单列表(卡片)
   每张卡:订单号 · 客户 · 交期 · 采购进度% · 物料完成度% · 物料风险
        ↓ 点「进入采购计划」
采购计划页(Purchase Plan = 采购的工作台,每订单唯一一个)
   物料汇总 → MRP结果 → 采购明细(系统生成)→ 询价对比 → 选供应商
   → 采购进度 → 收货 → 验货 → 成本汇总 → 物料风险
```

- **首屏从"物料队列"改为"订单卡片"**。物料明细**只在进入某订单的采购计划后才出现**。
- 原 `/procurement` 的"待下单/待催货/待验收"三队列**降级为"今日跨订单动作"次级视图**(Helen 仍能一眼看全局待办),但**主视图是订单**。
- 一切计算结果(MRP 建议量、汇总、成本)**系统算好直接展示**,采购只点"确认/选供应商/议价"。

---

## 2. Purchase Plan Data Model(采购计划数据模型)

**采购计划是这套架构最重要的对象。每个订单恰好拥有一个采购计划。**

### 🆕 `purchase_plans`(1:1 with orders)
| 列 | 说明 |
|---|---|
| id / order_id(unique FK) | 一订单一计划 |
| plan_status | draft / generating / active / closed |
| material_completion_pct | 物料完成度(业务物料包齐全度) |
| mrp_generated_at | MRP 自动生成采购明细的时间 |
| generated_from_bom | 标记由哪次 BOM 提交生成 |
| created_at / updated_at | — |

### 复用 `procurement_line_items` 作「采购明细 = Purchase Items」(增列)
| 增列 | 说明 |
|---|---|
| purchase_plan_id(FK→purchase_plans) | 归属计划 |
| bom_id(FK→materials_bom) | **回溯真实来源**(每条采购明细 = 哪个物料汇总来) |
| suggested_qty | MRP 算出的建议采购量(系统算) |
| loss_pct / inventory_deduct / reuse_deduct | MRP 中间量(可解释) |
| confirmed_qty | 采购确认的最终采购量(人决策) |

> 采购**永不手建** Purchase Items —— 全由 MRP 自动生成,采购只改 `confirmed_qty` / 选供应商。

---

## 3. Automatic MRP Flow(自动 MRP 计算)

**触发**:业务点「提交采购」(Step A 已有的动作)→ 系统自动建 Purchase Plan + 逐物料生成 Purchase Items。

**公式(每个物料一行):**
```
建议采购量 = PO数量 × 单耗 × (1 + 损耗%) − 现有库存 − 可复用余料
```

**输入全部已存在/可取:**
| 项 | 来源 | v1 处理 |
|---|---|---|
| PO 数量 | `orders.quantity` ✅ | 直接用 |
| 单耗 | `materials_bom.qty_per_piece` ✅ | 直接用 |
| 损耗% | `order_cost_baseline.waste_pct`(默认3)✅ | 取基线,无则默认 3% |
| 现有库存 | 🆕`warehouse_inventory`(Phase 2) | **v1 = 0** |
| 可复用余料 | 🆕`leftover_inventory`(Phase 2) | **v1 = 0** |

**示例(面料):** PO 10000 × 单耗 0.265 × 1.02 损耗 = 2703kg − 库存120 − 余料180 = **建议 2403kg**。采购**只确认,不重算**。

> v1(无库存表)= `PO × 单耗 × (1+损耗)`;Phase 2 接入库存/余料后,扣减自动生效,公式不变。

---

## 4. Business Submission Flow(业务提交流程)

```
业务补全物料包(materials_bom 每个物料齐全)
   每物料必含:名称/规格/单耗/单位/颜色/建议供应商/损耗/样品状态/备注/版本/业务确认
        ↓ 点「提交采购」(= 一个里程碑动作,Step A 已有)
系统:① 校验(关键物料齐全?)→ ② 锁定物料包(提交后不可改,改需走"修订")
     → ③ 自动建 Purchase Plan + 跑 MRP 生成采购明细 → ④ 通知采购
```

- **Step A 已落地** ①提交动作 + ④通知。**v2 要补**:②提交后锁定(改需修订)、③自动建计划 + 自动 MRP。
- 物料包字段大部分 `materials_bom` 已有(name/spec/qty_per_piece/unit/color/supplier);需补:`loss_rate`(可取基线)、`version`、`business_approved`、`remarks`(已有 notes)。

---

## 5. Procurement Workflow(采购工作流)

进入某订单的采购计划页后:
```
看 MRP 自动生成的采购明细(建议量已算好)
   → 询价(录多家供应商报价)→ 报价对比 → 选定供应商
   → 下单(确认量+价+PO号)→ 追踪(催货/在途)
   → 收货(实收)→ 验货(数量+品质)→ 业务复核 → 料齐 → 软提醒放行大货生产
```

**采购只做决策**:选供应商 / 议价 / 分配 / 下单 / 跟催 / 收货 / 验货 / 供应商评价 / 成本控制。
**采购不做**:算物料量 / 算总量 / 合并 Excel / 拆采购行 / 重算 BOM。

---

## 6. Database Evolution(数据库演进)

> 只增不毁,FK 到 orders,开 RLS,日志 append-only,人工执行迁移。

| 阶段 | 表/列 | 用途 |
|---|---|---|
| 本期 | 🆕`purchase_plans`(1:1 order) | 采购计划主对象 |
| 本期 | `procurement_line_items` 增列(purchase_plan_id / bom_id / suggested_qty / loss_pct / inventory_deduct / reuse_deduct / confirmed_qty) | 采购明细=Purchase Items,带 MRP 来源与中间量 |
| 本期 | `materials_bom` 增列(loss_rate / version / business_approved) | 物料包补全 |
| 询价期 | 🆕`supplier_quotes`(order/bom/line + supplier + price + moq + lead_days + selected) | 多家报价、选优 |
| Phase 2 | 🆕`warehouse_inventory` / 🆕`leftover_inventory` | MRP 扣库存/余料 |

---

## 7. UI Wireframe(线框)

**A. 采购中心首屏(订单卡)**
```
┌───────────────────────────────────────────────┐
│ QM-20260403-035   客户 RAG      交期 2026-07-18 │
│ 采购进度 ▓▓▓▓▓▓▓░░ 72%   物料完成度 68%         │
│ 物料风险 🟠 中                  [进入采购计划 →] │
└───────────────────────────────────────────────┘
（按交期/风险排序;只显示订单,不显示物料)
```

**B. 采购计划页(进入某订单后)**
```
物料汇总 | MRP结果(建议量,系统算)
─────────────────────────────────
采购明细(自动生成,采购只确认/选供应商):
  主面料  建议2403kg  [询价][选供应商][下单]
  网布    建议 310kg  [询价]...
─────────────────────────────────
询价对比 | 选供应商 | 采购进度 | 收货 | 验货 | 成本汇总 | 物料风险
```

> 我可另出一张高保真 mockup 给你看版面。

---

## 8. Migration Strategy(迁移策略)

1. **加法 + Feature Flag**(`SC_ORDER_CENTRIC`):off=维持现状,灰度 admin→采购→全员。
2. **并行过渡**:新"订单首屏 + 采购计划页"与旧"物料三队列"并存,验证无误再把旧队列降级为次级视图,不一刀切。
3. **存量数据**:为现有订单回填 `purchase_plans`(1:1);现有 `procurement_line_items` 回填 `purchase_plan_id`(由 order_id 推)。真实那条(防潮纸)归入其订单的计划。
4. **不双份**:采购明细仍是 `procurement_line_items`,只是"归到计划下 + 带 MRP 来源",不另建表。
5. **SQL 人工执行 / build+check / diff 审 / 批了才 push**(沿用纪律)。

---

## 路线图(本原则如何重排采购流 4 段)

| 段 | 原计划 | v2 重定义 |
|---|---|---|
| Step A | 业务提交原辅料单 ✅已上线 | 不变(下游改为自动 MRP) |
| **Step B** | 采购"汇总"(人) | **改为:提交→系统自动建计划+MRP生成采购明细;采购中心首屏改订单卡;采购计划页** ← v2 核心 |
| Step C | 询价 | 不变(supplier_quotes 多报价选优) |
| Step D | 验收+复核+放行 | 不变 |

---

## 决定(已定 2026-06-28)
1. 采购计划 = **独立表 `purchase_plans`**(first-class 对象)。
2. MRP v1 = **库存=0、余料=0 先上线**(`建议量=PO×单耗×(1+损耗)`),Phase 2 接库存自动扣减。
3. 旧三队列 = **并行过渡**(新订单首屏+采购计划页 与 旧队列并存,验证后把旧的降为"今日跨订单动作"次级视图)。
4. 物料包"提交后锁定" = **Step B 一起做**(提交→锁定→建计划+MRP 连贯)。

## Step B 落地清单(据上述决定)
- **Migration**:🆕`purchase_plans`(1:1 订单)+ `procurement_line_items` 增列(purchase_plan_id/bom_id/suggested_qty/loss_pct/confirmed_qty)+ `materials_bom` 增 `version`(支持提交后锁定/撤回修订)。
- **逻辑**:`submitBomToProcurement` 升级 → 提交时①锁定 BOM(submit_status=submitted,UI 禁编辑,改需"撤回修订")②建 purchase_plan ③跑 MRP 逐物料生成 procurement_line_items(suggested_qty)。
- **UI**:`/procurement` 加**订单卡首屏**(Feature Flag,与旧三队列并行)+ **采购计划页**(MRP 结果 + 自动生成的采购明细 + 确认量)。下单/询价复用现有 + 留给 Step C。
