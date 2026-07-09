# QIMO OS V1.0 — 五大中心最终产品蓝图（Final Product Blueprint）

> **Date**: 2026-06-30 · 角色视角：CPO + COO + 外贸服装 ERP 专家。
> **定位**：QIMO OS 不是 ERP，是 **AI Operating System**——全公司所有部门围绕**一条订单价值链**共享**同一份数据**，由 AI 全程辅助执行。
> **指导周期**：未来 3~5 年产品开发的最终蓝图。基于**真实系统/代码/业务**，**诚实评分，不替你乐观**。
> 图例：✅ 企业级在用 · ✅✅ 本轮亲验 · 🟡 部分/Demo/未接通 · 🔴 缺失。
> **七原则**：① 一条价值链 ② 一次录入全链引用 ③ 部门只拥有自己的数据 ④ AI 不是真相·关键节点人工确认 ⑤ 页面不维护别部门数据 ⑥ 统计 Derived-Never-Stored ⑦ AI 真减操作。

---

## §0 第一原则 — 唯一价值链（任何数据沿此流动，禁跳跃、禁重录）
```
Customer → Inquiry → Sample → Quote → Customer PO → PO Compare → Order
→ 生产执行单 → Material Requirement → Procurement → Production → QC → Packing
→ Shipment → Invoice → Payment → Profit
```

---

## ① 最终结构图 — Order Center = Enterprise Operation Hub

```
                     ┌──────────────────────────────────────────────┐
   ①业务开发中心 ───► │      ② 订单执行中心 = ENTERPRISE OPERATION HUB   │ ◄─── ⑤财务中心
   (成交前商业)        │   拥有: Order / Order Line / 18关卡 / 生产执行单  │      (钱/成本/利润)
   Customer/Inquiry   │   一切挂 order_id —— 全公司数据的物理脊柱          │
   /Sample/Quote      │                                              │
        │ Approved    └───┬───────────────┬───────────────┬──────────┘
        └────────────────►│               │               │
                     ③采购中心        ④生产中心         (出运/收款)
                  (BOM/核料/采购)    (排产/QC/工厂)      Shipment→Invoice→Payment
                          └───────────────┴──────────────────────────► Profit(⑤)
   规则: 没有 Order 就没有采购/生产/利润 —— 任何业务事实都不得绕过 Hub。
```

---

## ② Order Center = Enterprise Operation Hub（整个系统最重要的定义）

**为什么订单执行中心必须是 Hub（不是五中心之一）？**
1. **物理脊柱**：全公司每个下游对象都挂 `order_id`——`materials_bom` / `milestones` / `procurement_line_items` / `manufacturing_orders` / `order_cost_baseline` / `profit_snapshots` 全部以 order_id 为外键。它是数据库层面**唯一的汇聚点**（Constitution 01「一切挂 order_id」）。
2. **成交真相 SSOT**：客户/款色码/数量/交期/成交价/条款的**唯一真相**在 `orders`+`order_line_items`；其余中心**只引用，不重录**。
3. **五中心都依赖它**：业务开发把 Approved Quote **交付**给它；采购/生产/财务都**从它取** order_id + 款色码 + 交期。

| 维度 | 内容 |
|---|---|
| **它拥有** | Order · Order Line(款色码) · 18 关卡生命周期 · 生产执行单(MO) · 客户要求/交期/包装/收款节点 |
| **它分发** | order_id · 款色码 · 数量 · 交期 → 采购/生产/财务（一次录入，全链引用） |
| **谁依赖它** | ③采购(BOM/需求挂 order_id) · ④生产(milestones/MO 挂 order_id) · ⑤财务(成本/利润挂 order_id) |
| **绝不能绕过它** | ❌ 无 Order 的采购 · ❌ 无 Order 的生产 · ❌ 无 Order 的利润核算。任何业务事实必须先成为/挂上一个 Order |
| **当前缺口** | Hub 现在**从手工建单起**，不是**从确认的 Customer PO 起**——上游 Customer PO / PO Compare 缺失🔴，导致 Hub 的"入口"还是人工，不是受控的 PO 确认 |

---

## ③~⑦ 五大责任中心（职责/拥有/引用/不可改/输入/输出 + KPI + AI 岗位）

> 五中心 = 五个**责任中心**，不是功能模块。

### ① 业务开发中心 — Responsibility: 把陌生客户变成已确认的报价
| | |
|---|---|
| **拥有(可改)** | 客户 `customers` · 跟进 `customer_rhythm` · 客户事项 `customer_matters` · 报价 `quoter_quotes`(+5训练表) · 询盘🟡 · 打样🔴 |
| **引用(只读)** | 产品款 `products` · 历史成本(CMT/单耗 RAG) |
| **绝不能改** | 订单 · 采购 · 生产 · 成本审批 |
| **输入** | 客户线索 · 询盘文件 · 成本训练数据 |
| **输出** | 确认客户 · **Approved Quote** → 交付 Hub |
| **经营 KPI** | 询盘→报价转化率🔴(需 Inquiry 对象) · 报价→成交率🟡(quoter.status won/lost 可算) · 客户复购率✅(orders 历史可算) · 报价响应时长🟡 |
| **AI 岗位** | **AI Quote Assistant**(报价助手)✅真生成草稿 · AI Sales Assistant(跟进)🟡 · AI Customer Researcher(背调)🔴(在 araos,非 QIMO) |

### ② 订单执行中心 = HUB — Responsibility: 把确认的需求准确、准时变成交付
| | |
|---|---|
| **拥有(可改)** | Order/Order Line ✅ · 18关卡 ✅ · 延期 ✅ · 生产执行单 MO ✅ · Customer PO🔴 · PO Compare🔴 |
| **引用(只读)** | 客户 · 产品款 · 报价(quoter_quotes，`origin_quote_id` 待接🟡) |
| **绝不能改** | 客户主数据 · 供应商 · 采购成本 · 生产工艺 |
| **输入** | Approved Quote(预填) · Customer PO(🔴手工) · 客户要求 |
| **输出** | order_id+款色码+交期 → 采购/生产/财务 |
| **经营 KPI** | 准时交付率✅(milestones/etd 可算,交付置信度引擎已在算) · 订单周期✅ · 异常关闭率🟡(delay_requests) · 订单准确率🟡(需 PO Compare) |
| **AI 岗位** | **AI Delivery Risk Manager**(交付风险官)✅✅**真执行**(置信度风险卡:为什么/哪节点/谁该做) · AI Order Reviewer(订单复核)🟡 · AI PO Compare Specialist🔴未建 |

### ③ 采购中心 — Responsibility: 让料按时、按价、按量到厂
| | |
|---|---|
| **拥有(可改)** | 核料/采购 `procurement_line_items` ✅ · 物料需求 `material_requirements`(MRP) ✅ · BOM `materials_bom` ✅ · 归并 `procurement_items`(P1)🟡 · 供应商🟡(纯文本,无主表) |
| **引用(只读)** | 订单 · 物料主数据 `material_master` |
| **绝不能改** | 客户 · 订单款色码 · 生产 · 价格审批 |
| **输入** | 订单 BOM · MRP 需求 |
| **输出** | 采购状态 · 对账单✅ · → 财务(AP) |
| **经营 KPI** | 到料及时率🟡(promised/expected/received 可算) · 采购成本✅ · 合并采购率✅✅(本轮 view) · 供应商交付率🔴(需主数据) · MOQ利用率🟡 · 返单效率🔴 |
| **AI 岗位** | **AI Procurement Analyst**(采购分析)✅✅(汇总:按物料/供应商) · AI Cost Optimizer🟡(价格异常) · AI Supplier Advisor🔴(无供应商主数据) |

### ④ 生产中心 — Responsibility: 让大货按期、合格出厂
| | |
|---|---|
| **拥有(可改)** | 工厂 `factories` ✅ · 排产🟡(仅 milestones) · 产前样/首中尾查(milestones)✅track · 生产异常🟡 |
| **引用(只读)** | 订单 · MO · 物料到位 |
| **绝不能改** | 报价 · 客户要求 · 采购价 |
| **输入** | 生产执行单 · 物料到位 |
| **输出** | 生产状态 · 交期预测 → QC/出运 |
| **经营 KPI** | 延期率✅(delay/milestones) · 首检通过率🔴(需结构化验货) · 一次合格率🔴 · 工厂评分🔴(需工厂绩效) |
| **AI 岗位** | **AI PMC**(排产/交期)🟡(置信度引擎做交期预测) · AI Quality Assistant🔴 · AI Factory Evaluator🔴 |

### ⑤ 财务中心（QIMO 侧）— Responsibility: 守住利润与现金
| | |
|---|---|
| **拥有(可改)** | 价格审批 `pre_order_price_approvals` ✅ · 成本基线 `order_cost_baseline` ✅ · 利润快照 `profit_snapshots` ✅ · 告警 `system_alerts` ✅ |
| **引用(只读)** | 订单金额 · 报价成本 · 采购成本 |
| **绝不能改** | 客户 · 订单款色码 · 生产状态 · 采购执行 |
| **输入** | 订单金额 · 报价/采购成本 · 实际(深账务在独立 finance 系统) |
| **输出** | 利润分析 · 价格审批结论 → 订单 · 低/负毛利告警 |
| **经营 KPI** | 利润率✅(gross_margin) · 现金流🟡 · 回款率🟡(AR 在 finance) · 应收周转🟡 |
| **AI 岗位** | **AI Financial Analyst**(利润分析)✅ · AI Risk Controller(毛利异常)✅(system_alerts) · AI Cost Controller🟡 |

---

## ⑧ AI 执行矩阵（真执行 vs 只展示 vs 只承诺）

| 节点 | AI 输入 | 主动能做 | **绝不能做**(Constitution 04) | 现状 |
|---|---|---|---|---|
| 报价 | 款/料/量 | 生成报价草稿 | 自动确认报价 | ✅ 真执行 |
| 交付风险 | milestones/延期 | 算置信度+给"谁该做什么" | 自动改交期/自动放行 | ✅✅ 真执行 |
| 采购汇总 | BOM/需求 | 按物料/供应商汇总 | 自动下采购单 | ✅✅(缺UI) |
| 利润异常 | 成本/售价 | 毛利告警 | 自动审批/付款 | ✅ |
| 询盘 | 文件 | OCR 抽取草稿 | 自动建客户/订单 | 🟡 解析了**不落库** |
| PO Compare | 客户PO | OCR+逐字段差异 | 自动确认订单 | 🔴 未建 |
| 推荐供应商 | 历史采购 | 候选+比价 | 自动选供应商 | 🔴 无主数据 |
| 补货/尾货 | 库存/到货 | 缺口建议 | 自动补货 | 🔴 |

> **真执行(4)**：报价生成 · 交付风险 · 采购汇总 · 利润告警。**只承诺没做**：PO Compare/推荐供应商/补货。**展示没执行**：询盘解析(不落库)。

---

## ⑨ 数据流矩阵（谁产谁、谁引用、是否重录）

| 数据 | 产出中心(Owner) | 引用中心 | 是否一次录入 |
|---|---|---|---|
| 客户 | 业务开发 | 全员 | 🟡 报价用字符串名、未连 customers(重录风险) |
| 报价/成本构成 | 业务开发 | 订单/财务 | ✅ |
| Order/款色码/交期 | **Hub** | 采购/生产/财务 | 🟡 从报价预填=重打(origin_quote_id 待接) |
| 生产执行单 MO | Hub | 生产/采购 | ✅ 绑定不复制 |
| BOM/单耗 | 采购(实例化自款) | 财务 | ✅(开发单耗);大货单耗🟡 |
| 采购量/价 | 采购 | 财务 | ✅ |
| 生产状态 | 生产 | Hub/全员 | 🟡 lifecycle 与 milestones 两处 |
| 成本/利润 | 财务 | 看板 | 🟡 利润 forecast/live/final 双源 |

---

## ⑩ 权限矩阵（真实 `lib/domain/roles.ts`）

| 数据 | Owner(可改) | 只读 | 越界红线 |
|---|---|---|---|
| 客户/跟进 | sales/admin | 全员 | 采购页不改客户 |
| 报价(价/margin) | sales/admin(CAN_SEE_FINANCIALS) | 采购看款不看价 | — |
| 订单/款色码 | sales/merchandiser/admin | 全员 | 订单页不改供应商 |
| 采购/供应商 | procurement/merchandiser/admin | 财务看额不看议价 | ⚠️ 旧 `procurement.ts` 含 finance→**待收紧** |
| 生产/QC/工厂 | production/production_manager/admin | 订单/采购 | 生产页不改报价 |
| 成本/利润/价审 | finance/admin | 业务(自己单) | 财务页不改生产 |

---

## ⑪ 系统完成度评分（诚实，按"日用覆盖"）

| 中心 | 完成度 | 企业级 / Demo |
|---|---|---|
| ② 订单执行(Hub) | **~70%** | 订单+18关卡+交付风险=**企业级**✅;PO/PO Compare 缺 |
| ① 业务开发 | **~55%** | 报价=**企业级**✅;询盘/打样/客户开发=Demo/缺 |
| ③ 采购 | **~55%** | 执行+汇总=**企业级**✅;供应商侧/复制采购/补货=缺 |
| ⑤ 财务(QIMO侧) | **~50%** | 成本/利润/价审=企业级✅;深账务在独立系统 |
| ④ 生产 | **~45%** | 里程碑+交期风险=企业级✅;排产/验货/工厂绩效=缺 |
| **整体 AI-OS** | **~55–60%** | **单链运营核心真在用、是真资产;商业起源+供应商侧+下游结构化是主缺口** |

**数据链体检**：一次录入🟡(quote→order 重录) · 全程共享✅(order_id 脊柱) · 唯一数据源🟡(利润双源/两套进度状态) · 权限隔离✅(旧采购 action 待收紧) · AI 辅助执行🟡(4 真执行+若干只承诺)。
**断链点**：① quote→order(`origin_quote_id` 未接) · ② Customer PO/PO Compare 缺(链起点) · ③ 采购实际成本回流。

---

## ⑬ 未来必补清单（按"上线后每天都会用"排序，不按开发难度）

**P0 — 每天用、价值最高、且多数小（建议先做）**
1. **采购汇总视图接 UI**——本轮 API 已发,采购每天看料/合单就用
2. **quote→order 一键带数据 + `origin_quote_id` 接线**——每单都走,消灭重录款/色/价
3. **同布同色合并采购汇总**——采购每天合单下单
4. **返单复制采购历史**——翻单每次都要(现只复制订单行)

**P1 — 高频、需补对象**
5. **供应商主数据 + 历史价/比价**——采购日常决策(现供应商裸文本)
6. **送货计划 / 到货跟踪视图**——催货跟单每天
7. **Customer PO 导入 + PO Compare**——每单起点核 PO(让 Hub 从确认 PO 起,而非手工)
8. **询盘/打样固化对象**——业务每天接询盘(现解析即丢)

**P2 — 重要但非每日**
9. 补货建议 / 尾货统计 / 退货
10. 结构化验货报告 / 工厂评分 / 排产
11. 利润 actual 统一(消双源) / 提成 / 回款率

---

## 一句话总指引（给未来 3~5 年）
**Order Center 是 Hub,已经是真资产;把"商业起源"接到 Hub 入口(Customer PO/PO Compare)、把每天用的采购功能(汇总UI/合并/返单/供应商历史)补齐、把 quote→order 接线消灭重录——QIMO OS 就从"能跑的订单系统"变成"外贸服装的 AI Operating System"。** 不靠架构,靠把 ⑬ 的 P0→P1 一件件做实,每件都小、都每天用、都让那条唯一价值链更不断。
</content>
