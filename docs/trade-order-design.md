# 采购成品 / 经销单 / Trade Order 流程设计契约

> 设计专项(2026-06-19)。**仅设计,不写代码、不建 migration、不动现有订单。** 动工前以此为契约。
> 背景:目前非 sample 订单一律走完整生产模板(~28 节点);公司有一类业务=**直接采购成品/现货/经销**,无需开裁/中查/尾查/工厂生产,只要采购→催货→验收→出运。

---

## 0. 现状审计结论(读代码核实)

| 审计项 | 现状(file:line) |
|---|---|
| `order_type` | DB CHECK 仅 `sample/bulk/repeat`(UI 显示 trial/urgent 兼容);**语义=风险/业务口味**,非流程类型。`lib/types.ts:6`、`lib/domain/gates.ts:13` |
| `order_purpose` | `text DEFAULT 'production'`,**CHECK `IN ('inquiry','sample','production')`**(`20260404_quote_sample_flow.sql:3-4`)。createOrder 读 `formData.order_purpose`(`orders.ts:121,350`)。**这就是"流程类型"维度。** |
| `getApplicableMilestones` | `lib/milestoneTemplate.ts:199`。**已按 `orderPurpose` 分流**:`=== 'sample'` 直接返回 `SAMPLE_MILESTONE_TEMPLATE`;否则用 `MILESTONE_TEMPLATE_V1` + 样品阶段过滤 + export/domestic 过滤。 |
| `MILESTONE_TEMPLATE_V1` | `lib/milestoneTemplate.ts:25-70`,~28 节点(PO确认→…→产前样→采购→开裁→中查→尾查→工厂完成→入库→放行→订舱→报关→出运→收款)。 |
| `SAMPLE_MILESTONE_TEMPLATE` | `:159-185`,8 节点(打样单确认→面料→制作→检验→寄样→寄出→客户确认→打样完成)。**已是"精简模板"先例**——trade 完全照此模式加。 |
| `skip_pre_production_sample` | 由 `sample_phase==='skip_all'` 驱动(`orders.ts:175`),只过滤 3 个产前样节点(`PRE_PRODUCTION_SAMPLE_STEPS`),**仍走完整生产流程**。不能用它实现 trade。 |
| 采购中心 | `procurement_line_items` 行级状态机(`lib/domain/procurement.ts`):pending_order→ordered→…→arrived→accepted;催货/验收/红绿灯/matters 齐全。**全按 `order_id`**。 |
| 出货 / 财务 / 单据 | `shipment_confirmations` / `order_financials` / `order_documents` **全按 `order_id`**(46 处),与里程碑解耦。 |
| `schedule.ts` | `TIMELINE` 按 step_key 配工期;**未知 step_key 直接 `throw`(`:232`)**。新节点必须登记 TIMELINE。 |

---

## 1. 推荐字段方案:扩展 `order_purpose='trade'`(不新建 fulfillment_type)

**判断:扩展 `order_purpose`,新增取值 `'trade'`。**

| 选项 | 评判 |
|---|---|
| ✅ **`order_purpose='trade'`(推荐)** | `order_purpose` 本就是"流程类型"维度,`getApplicableMilestones` 已 key 在它上面;加 trade 与 sample 分支**完全平行、最小改动**。production/sample/trade **互斥**,天然适合单字段枚举。 |
| ❌ 新增 `fulfillment_type` | 会引入与 order_purpose **正交但实则互斥**的第二维度 → 出现 `purpose=production + fulfillment=trade` 这种无意义组合,路由要处理笛卡尔积。除非将来真有"生产+经销"混合履约,否则纯属冗余。 |
| ❌ 复用 `order_type` | order_type=风险/业务口味(试单/正常/翻单/加急),**与流程正交**——一张 trade 单仍可以是"正常"或"翻单"。混用会污染风险维度。 |

**字段改动(仅记需求,本期不建 migration):**
- 改 `orders.order_purpose` 的 CHECK 约束:`IN ('inquiry','sample','production','trade')`(DROP 旧约束 + ADD 新约束)。**这是 trade 订单唯一的 DB 迁移依赖。**
- 建单表单"订单用途"加一项「采购成品 / 经销单」→ 提交 `order_purpose='trade'`(类似现在样品单提交 `'sample'`)。
- `getApplicableMilestones` 顶部加一行分支:`if (orderPurpose === 'trade') return applyShippingBranch(TRADE_MILESTONE_TEMPLATE, deliveryType);`(export/domestic 出货尾巴复用现有过滤)。

---

## 2. Trade 里程碑模板草案(最大化复用已有 step_key)

**设计铁律(因 `schedule.ts` 对未知 key 会 throw):优先复用已有 step_key(已带 TIMELINE/门禁/置信度/i18n),只为"供应商备货"新增 1 个 key。**

| # | 节点(step_key) | 复用? | owner_role | 关键? | 说明 |
|---|---|---|---|---|---|
| 1 | PO确认 `po_confirmed` | ♻️复用 | sales | ✓ | 订单/PO 确认,与生产单同 key |
| 2 | 订单审核 `finance_approval` | ♻️复用 | finance | ✓ | 财务审/预算确认(可选保留) |
| 3 | 供应商下单 `procurement_order_placed` | ♻️复用 | procurement | ✓ | 向成品供应商下采购单 |
| 4 | 供应商备货/交期确认 `supplier_goods_ready` | 🆕**新增** | procurement | ✓ | 唯一新 key(需登记 TIMELINE+criticalNodes+i18n) |
| 5 | 成品验货 `inspection_release` | ♻️复用 | qc/merchandiser | ✓ | 复用"验货/放行"作成品到货验收 |
| 6 | 包装资料确认 `packing_method_confirmed` | ♻️复用 | merchandiser | ✓ | 包装/唛头资料 |
| 7 | 订舱/物流安排 `booking_done` | ♻️复用(export) | merchandiser | ✓ | domestic 单自动过滤 |
| 8 | 单证/报关 `customs_export` | ♻️复用(export) | merchandiser | ✓ | 出口单证;domestic 过滤 |
| 9 | 出运 / 国内送仓 `shipment_execute`(export)或 `domestic_delivery`(domestic) | ♻️复用 | logistics | ✓ | 复用现有 export/domestic 分支 |
| 10 | 回款完成 `payment_received` | ♻️复用 | finance | ✓ | 单证/回款跟进终点 |

- **export/domestic 分支**:trade 模板同样套用现有 `EXPORT_ONLY_STEPS` 过滤——DDP 出口走订舱/报关/出运,FOB/人民币/国内走 `domestic_delivery`。零新逻辑。
- **新 key `supplier_goods_ready` 的最小配套**(实现期):`schedule.ts TIMELINE` 加偏移、`criticalNodes` 登记(若要计入交付置信度)、`i18n` 加中文名、owner_role 归 procurement。**就这一个 key 要全套接线**,其余全继承。
- **工期(TIMELINE)取舍**:复用 key 自带的是"生产节奏"偏移,trade 节奏更短。MVP 可先接受偏移近似(不会崩,只是日期略松);Phase 2 视情给 trade 关键 key 配 `customerScheduleOverrides` 或独立 `TRADE_TIMELINE`。

---

## 3. 明确**不生成**的生产节点(trade 模板里直接没有)

产前样三件(`pre_production_sample_ready/sent/approved`)、生产预评估 `bulk_materials_confirmed`、加工费确认 `processing_fee_confirmed`、工厂匹配 `factory_confirmed`、**面辅料采购 `order_docs_bom_complete` / `materials_received_inspected`**、产前会 `pre_production_meeting`、**开裁 `production_kickoff`**、**中查 `mid_qc_check`**、**尾查 `final_qc_check`**、**工厂完成 `factory_completion`**、剩余物料回收 `leftover_collection`、成品入库 `finished_goods_warehouse`(如成品直发可去掉,需入库则保留)。

> 机制上"不生成"=trade 模板数组里**根本不含**这些 step_key。门禁/置信度/排期都是**按节点存在与否**生效,节点不存在则相关逻辑天然不触发,**无需逐处加 if**。

---

## 4. 与采购中心的关系(trade 的执行主线)

- **trade 订单的真实执行流 = 采购中心**。"供应商下单→备货/交期→催货→成品验收"本质就是 `procurement_line_items` 状态机(已建好:下单/催货/到货验收/让步审批/红绿灯/风险 matters)。
- **里程碑只做"总控节点"**:订单时间线上的 `procurement_order_placed` / `supplier_goods_ready` / `inspection_release` 是**给老板/跨部门看的粗粒度阶段灯**;细到"哪个供应商哪箱货催了几次"在采购中心。
- **联动**(复用现有钩子范式,实现期):采购行全部 `accepted` → 提示/自动完成 `inspection_release`;采购行红灯 → 已有 `procurement_matters` + 可 fire `runtime_events` 扣交付置信度。**不新建联动机制,复用 Phase1 钩子。**
- trade 订单可不用"原辅料 BOM"那套(那是给自产备料的);成品采购直接在采购中心建成品行即可。

---

## 5. 对现有订单零影响(强约束)

- `getApplicableMilestones` 是**按 `orderPurpose` 分支**:`production`→老 28 节点模板**一字不改**;`sample`→样品模板**一字不改**;`trade`→新模板**仅对新建 trade 单生效**。
- 存量订单 `order_purpose` 只会是 `production/sample`,**永远进不了 trade 分支**。
- trade 不改 `MILESTONE_TEMPLATE_V1`、不改 `SAMPLE_MILESTONE_TEMPLATE`、不改 schedule 现有 key、不改门禁/置信度现有逻辑——**纯加法**。

---

## 6. 财务 / 出运 / 单证是否复用(结论:全复用,零改动)

| 模块 | 复用结论 |
|---|---|
| 财务 `order_financials` | ✅ 按 order_id,trade 单照常有收款/付款/经营状态卡。收款门禁等照用。 |
| 出货 `shipment_confirmations` | ✅ 按 order_id 的四步签核(业务→财务→物流),trade 单出运直接复用,**与里程碑解耦**。 |
| 单据 `order_documents` | ✅ 按 order_id;PI/CI/装箱单/采购单都能开。trade 单可能更需要 CI/装箱单/报关单证。 |
| 采购 `procurement_line_items` | ✅ 即 trade 主执行流(见 §4)。 |
| 待审批中心 / 延期 / 取消 / 风险卡 | ✅ 全按 order_id / 按节点,trade 单自动纳入,节点少而已。 |

**唯一需确认**(实现期):`lib/domain/gates.ts` 的业务门禁是否有"假设 production 才成立"的规则;因门禁按 step_key 触发、trade 缺这些 key 即不触发,预计无碍,但需逐条过一遍。

---

## 7. 最小 MVP 范围

**目标:能建一张 trade 单,跑通"采购→验收→出运→回款"的总控节点 + 采购中心执行,且对现有订单零影响。**

1. `order_purpose` CHECK 加 `'trade'`(1 个小 migration)。
2. `TRADE_MILESTONE_TEMPLATE`(§2 那 10 节点,9 复用 + 1 新)+ `getApplicableMilestones` 加 trade 分支。
3. 新 key `supplier_goods_ready`:TIMELINE 偏移 + i18n + owner_role(criticalNodes 可 Phase2 再加)。
4. 建单表单"订单用途"加「采购成品/经销单」选项。
5. 采购/出货/财务/单据**全部复用,不改**。

**MVP 不含**:trade 专属精细工期(先用近似)、采购行↔里程碑自动联动(先手动)、trade 专属风险规则、成品入库可选化。

---

## 8. 数据迁移需求

- **唯一必需**:`ALTER TABLE orders DROP CONSTRAINT <order_purpose_check>; ADD CONSTRAINT ... CHECK (order_purpose IN ('inquiry','sample','production','trade'));`(幂等写法,设计阶段不建)。
- **存量数据**:不动。无回填、无 backfill —— 存量全是 production/sample。
- 新 step_key `supplier_goods_ready` 不需要建表(milestones 表通用),只是模板新增行。

---

## 9. 风险点

1. **schedule.ts 未知 key 抛错**(最大坑):任何 trade 新 step_key 必须同步登记 `TIMELINE`,否则建单即崩。→ 设计上**最大化复用已有 key**、新 key 严格配套。
2. **复用 key 的工期语义错位**:复用生产节奏偏移会让 trade 日期偏松。→ MVP 接受近似;Phase2 给关键节点配 trade 偏移/客户 override。
3. **门禁/置信度按 production 隐含假设**:需逐条核 `gates.ts` / `criticalNodes`,确认缺节点=不触发(预计无碍)。
4. **owner_role 与责任人**:trade 少了生产/品控环节,验货归谁(qc 还是 merchandiser)、备货催货归 procurement,需与组织角色对齐(2026 版角色已就绪)。
5. **成品入库是否保留**:成品直发客户 vs 先入自有仓,影响是否保留 `finished_goods_warehouse`。→ 设为模板可选,按业务定。
6. **报表/统计口径**:trade 单数量/金额计入客户销售目标、利润等照常(按 order_id),但"生产准时率"等生产类指标应排除 trade 单(分母不该含),需在分析侧加 `order_purpose != 'trade'` 过滤。

---

## 10. 分阶段实施计划(全程纯加法,建议 Feature Flag `TRADE_ORDER=off/admin/on`)

| 阶段 | 内容 | 性质 |
|---|---|---|
| **0 模板与字段** | order_purpose CHECK 加 trade(migration)+ `TRADE_MILESTONE_TEMPLATE` + getApplicableMilestones 分支 + 新 key 的 TIMELINE/i18n/owner_role | 纯加法 |
| **1 建单入口** | 建单表单"订单用途"加「采购成品/经销单」;trade 单跳过生产相关必填(款数/颜色等按需放宽) | 纯加法,flag 控 |
| **2 执行打通** | trade 单详情页主推采购中心;验货节点与采购行 accepted 提示联动;出货/财务/单据复用验证 | 纯加法 |
| **3 精修** | trade 专属工期、采购↔里程碑自动联动、风险规则、报表口径排除 trade 的生产类指标 | 纯加法 |
| **4(可选)** | trade 单据模板优化(更偏贸易:CI/箱单/报关)、经销专属字段(进货价/销售价/毛利) | 加法 |

**回滚**:flag 回 `off`,新建只出 production/sample;已建 trade 单 DB 保留无害。
**绝对不动**:`MILESTONE_TEMPLATE_V1` / `SAMPLE_MILESTONE_TEMPLATE` / schedule 现有 key / 现有门禁置信度逻辑。每阶段 `npm run build && npm run check`,`pre-deploy-check` 守住"生产/样品模板节点数不变"。

---

*落档 2026-06-19。与 [order-line-items-design.md](order-line-items-design.md)(订单明细)是两件独立的事:本文是订单**类型/流程**,那篇是订单**数据明细**。两者都未动工。*
