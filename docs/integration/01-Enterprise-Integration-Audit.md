# QIMO OS — Enterprise Integration Audit（跨仓库集成审计）

> **Status**: 🟡 审计报告（纯分析，不写代码 / 不写 migration / 不改库 / 不提交 / 不 push）。
> **Date**: 2026-06-29 · 遵守 Constitution / Development-Principles / DoD / EA V1.0 / ADR。**Evolution NOT Rewrite**。
> **范围**: 三个已点名仓库 —— QIMO OS · finance-system · clients-Hunters-OS（araos）。`growth-os`（`clients-growth-os`）疑似客户开发并行/旧版，**默认不纳入**，待用户定夺。
> **本文 = 第一/二/三步**（Repository Audit · Cross-Repo Object Audit · Cross-Repo Relationship）。第四步见 `02-…`，第五/七步见 `03-…`，第六步见 `04-…`。

---

## 0. 一句话结论（answer-first）

> **三个仓库不是重复造同一个系统，而是一条企业价值链的三个阶段，被脆弱的"名字字符串"胶水勉强连着。** 真正的风险不是"重复建设系统"，而是**重复存储同一份数据却没有共享身份键**（客户/订单/报价在三处各存一份、靠 name 匹配）。集成的本质 = **建立跨库身份脊柱 + 把现有脆弱耦合升级为契约**，而不是合并数据库、不是推倒重写。

```
ARAOS（获客前端）   ──赢单handoff──▶   QIMO OS（订单/生产编排核心）   ──order/quotation──▶   finance-system（钱的真相）
线索→公司→Deal→外联→售前报价策略        确认客户→订单→产品→物料→生产任务→采购→生产→质检→出运      预算单→成本实际→发票→AR/AP→收付款→总账→结算利润
[Supabase hpdcqjf…]                    [Supabase scrtebex…]                                  [Supabase qpoboel…]
        └─ 桥已建但关闭(pending)           └─ finance 直连QIMO库(service key)读orders            └─ 钱的真相, 但客户/订单/产品各存一份
```

---

## 1. Repository Audit（逐仓库）

### 1.1 QIMO OS — `order-metronome`
| 维度 | 内容 |
|---|---|
| **Purpose** | 企业操作系统核心：把客户需求编排成"订单→产品→物料→生产任务→采购→生产→质检→包装→出运"。理念"卡风险不走流程"。 |
| **Architecture** | Next.js 16 + React 19 + Supabase（`scrtebexbxablybqpdla`）。Server Actions 为主（`app/actions/*`，83 个）+ API Routes（46）。Runtime Confidence 投影引擎（append-only 事件）。 |
| **Pages** | 48 `page.tsx`：/orders /products /material-master /procurement /quoter /sales-targets /my-customers /warehouse /risk-orders /dashboard 等。 |
| **Actions** | bom / orders / procurement / manufacturing-order / quoter / runtime-confidence / delays / order-amendments / my-customers 等。 |
| **DB Tables** | 121 CREATE TABLE。核心：orders / order_line_items / milestones / materials_bom / material_requirements / procurement_items / manufacturing_orders / products / product_variants / product_definitions / product_bom_templates / customers / customer_rhythm / customer_matters / quoter_quotes(+5 训练表) / order_cost_baseline / profit_snapshots / system_alerts / runtime_events。 |
| **Business Objects** | Customer Order · Material Package · Manufacturing Order（三真相对象）+ Product/Variant/Definition + Quote + Customer + Procurement Item + (finance 脚手架) 。 |
| **Current Domain** | EA V1.0 的 13 域宿主；本审计中作为**企业集成宿主（Enterprise Host）**。 |
| **Current Status** | 生产中（order.qimoactivewear.com）。Order/Material/MP/Procurement核料 ✅；Product Phase1+2A ✅；Quote 模块在线但未接 customer/product。 |
| **Source of Truth** | 确认客户 / 订单 / 款色码 / 产品定义 / 物料包 / 采购核料 / 生产任务单。 |
| **Dependencies** | 被 finance-system **直连读库**（service key）+ webhook 推送；被 ARAOS handoff（关闭中）指向。对外发 finance-callback（审批）。 |
| ⚠️ **风险** | iCloud 多副本（CloudDocs/~/dev/~/Projects/~/order-metronome）——权威副本须锁定 CloudDocs（CLAUDE.md 2026-05-23 事故同型）。 |

### 1.2 finance-system — `财务系统`
| 维度 | 内容 |
|---|---|
| **Purpose** | 完整复式财务后台：预算单(预算单) → 成本/发票实际 → 预算vs实际结算 → AR/AP 台账 → 总账(科目→凭证→试算→损益) → 银行对账 → 出口退税 → 工资 → 控制中心(审计/冻结/信任/结账/完整性引擎+AI agents)。QIMO 订单真相**下游的"钱的真相"**。 |
| **Architecture** | Next.js 16（`src/app/`）+ Supabase（`qpoboelobqnfbytugzkw`）+ Anthropic SDK + 企业微信。**逻辑在 API routes**（无 `use server`，全部 `src/app/api/.../route.ts` + `src/lib/`）。每日 cron `/api/cron/orchestrate`。 |
| **Pages** | 56：dashboard / orders(budget) / receivables / payables / payments / costs / profit-control / gl / reports / bank / cashflow / customs / tax-refund / control-center / profiles / payroll。 |
| **Actions/API** | integration(sync/webhook/approve) / profit / gl / settlement / documents(Claude OCR) / control-center 引擎 / agents / wecom。 |
| **DB Tables** | ~52：**budget_orders（自有订单实体）** · synced_orders（QIMO 订单镜像）· customers（自有副本）· products(自有) · cost_items · order_settlements · actual_invoices · profit_order_styles · receivable_payments(+allocations) · payable_records · supplier_payments · suppliers · accounts/journal_entries/journal_lines/gl_balances · exchange_rates(FX master) · bank_* · tax_refunds · payroll_* · prepayments · inventory · 多租户/审计/SOT 表。 |
| **Business Objects** | Budget Order · Cost(actuals) · Invoice · Receivable(AR) · Payable(AP) · Payment · GL/Journal · Profit(settled) · Supplier · ExchangeRate · Tax · Payroll · (Customer/Order/Product 自有副本)。 |
| **Current Domain** | Finance Domain（企业唯一真实总账）。 |
| **Current Status** | 生产中。与 QIMO 已三通道集成（见 §3）。 |
| **Source of Truth** | **钱的一切实际**：成本实际 / 发票 / AR / AP / 收付款 / 总账 / 结算利润 / 汇率 / 退税 / 工资。 |
| **Dependencies** | ① 入站 webhook 收 QIMO order+quotation；② **直连 QIMO Supabase**（`METRONOME_SUPABASE_SERVICE_KEY` 读 orders 表）；③ 出站 callback 推 QIMO `/api/integration/finance-callback`。**全部 string 键（order_no/customer_name），无共享 UUID。** |

### 1.3 clients-Hunters-OS — `araos`
| 维度 | 内容 |
|---|---|
| **Purpose** | AI 驱动的 B2B 出海获客 OS（QIMO 缺的漏斗顶端）：自动发现潜客公司→富化(联系人/邮箱/技术栈/采购意图/海关数据)→AI 评分分级→冷启动外联邮件→追踪回复→推进 pipeline(lead→sample→quote→order)。定位为**通用获客 OS**，QIMO=租户#1/服装模板#1。 |
| **Architecture** | Next.js 16（`app/`）+ Supabase（`hpdcqjfwmcbdlgywhjog`）。`actions/`(28) + `agents/`(LLM 发现/富化/评分/外联/跟进) + `workers/`(queue-worker / reply-scanner IMAP) + `lib/`(llm/enrichment/email/quote/metronome)。Railway/Vercel cron。 |
| **Pages** | 35：/leads(+discovery) /companies(+contacts/outreach/report/strategy/timeline) /contacts /pipeline /deals /outreach /samples /orders /tasks /today /approvals /analytics /command。 |
| **Actions/Agents** | discovery/companies/contacts/deals/**samples**/**orders**(QIMO handoff)/quote/outreach/intel/tiering/reports；agents: discovery scrapers/enrich/score/tiering/report/outreach/email/followup。 |
| **DB Tables** | 35：**companies（潜客主体, 枢纽）** · contacts · **deals（CRM pipeline）** · customer_events(活动总线) · outreach_logs/conversations/reply_events · followup_tasks/runs/tasks · **quote_strategies + pricing_config（售前报价策略引擎）** · quotes(legacy) · **samples / orders（薄 pre-handoff, 含 pushed_to_metronome）** · **metronome_handoffs（→QIMO 出站日志）** · factory_profiles/capabilities · customer_scores/intelligence_reports · agent_queue/actions。 |
| **Business Objects** | Lead · Company(prospect) · Contact · Deal/Opportunity · Activity/Event · Outreach/Email · 售前 Quote-strategy · Sample · (薄)Order · Factory(本地副本)。 |
| **Current Domain** | 客户开发/商业获客 → 应升级为 **Commercial / Customer-Development / (售前)Quote 域**。 |
| **Current Status** | 生产中（单租户，RLS 还是 `USING(true)` 占位）。**与 QIMO 的 handoff 已接好但关闭**。 |
| **Source of Truth** | 线索/潜客公司/联系人/Deal/外联消息/售前报价策略 —— **漏斗顶端，QIMO 完全没有**。 |
| **Dependencies** | LLM(Claude+OpenAI)、邮件(SMTP/IMAP)、富化(Apollo/RocketReach/ImportYeti)。对 QIMO：`lib/metronome/*` + `metronome_handoffs` 出站桥（`METRONOME_WEBHOOK_URL` **未设→关闭**）。**无入站、无 finance 引用。** |

---

## 2. Cross Repository Object Audit（按对象，不按页面）

> 列：对象 / 在哪个 Repo / 域 / 数据库表 / 是否 SoT / 有无重复 / 处置（Keep·Merge·Split·Reference·Archive）。
> **处置判据**：同一对象**同一生命周期阶段**只能一个 SoT（One Owner）；不同阶段可 Split-by-stage；薄镜像→Reference；本地复制的他域真相→Archive/Reference。

| 对象 | Repo · 域 | 表 | SoT? | 重复？ | **处置** |
|---|---|---|---|---|---|
| **Lead** | ARAOS · Commercial | `companies`(status raw) | ✅ | 无（QIMO 无） | **Keep @ARAOS** |
| **Company（潜客）** | ARAOS · Commercial | `companies` | ✅ 潜客阶段 | 与 QIMO customers 概念冲突 | **Split-by-stage**：潜客 @ARAOS |
| **Contact** | ARAOS · Commercial | `contacts` | ✅ | QIMO 仅嵌在 customers | **Keep @ARAOS**（QIMO Reference） |
| **Opportunity / Deal** | ARAOS · Commercial | `deals`+`customer_events` | ✅ | 无（QIMO 无） | **Keep @ARAOS** |
| **Outreach / Email** | ARAOS · Commercial | `outreach_logs`/`conversations` | ✅ | 无（QIMO 无邮件引擎） | **Keep @ARAOS** |
| **Customer（确认）** | QIMO · Customer | `customers` | ✅ 确认阶段 | ARAOS companies / finance customers 各一份 | **Split-by-stage + Reference**：确认客户 @QIMO=企业 SoT；ARAOS 赢单晋升写入；finance 引用 `qimo_customer_id`（停止按 name 自建） |
| **Inquiry / RFQ** | QIMO · Inquiry | `parseInquiryFile`(未落库) | 🟡 | ARAOS 无 OCR | **Keep @QIMO**（EA V1.1 固化）；ARAOS 消费结果 |
| **Quote（正式：成本/单耗/margin）** | QIMO · Quote | `quoter_quotes`(+训练) | ✅ | ARAOS quote_strategies / finance _cost_breakdown | **Merge→QIMO SoT**：正式报价真相 @QIMO；ARAOS=售前策略(Reference)；finance=只读 forecast |
| **售前报价策略 / 议价 margin 阶梯** | ARAOS · Commercial | `quote_strategies`+`pricing_config` | ✅ 决策支持 | 与 QIMO quoter 成本模型部分重叠 | **Keep @ARAOS（决策支持，非成交真相）**；成交时引用 QIMO 正式 Quote |
| **Product / Variant / Definition / BOM** | QIMO · Product | `products`/`product_*` | ✅ | finance products / ARAOS 自由文本 | **Keep @QIMO**；finance/ARAOS Reference |
| **Customer Order** | QIMO · Order | `orders`+`order_line_items` | ✅ | finance budget_orders+synced_orders；ARAOS orders | **Keep @QIMO=企业 SoT**；finance synced_orders=cache(改用 id)；ARAOS orders→**Archive 为 handoff 记录** |
| **Manufacturing Order（=生产任务单）** | QIMO · MP | `manufacturing_orders` | ✅ | 无 | **Keep @QIMO** |
| **Material Package / Requirement / Procurement Item** | QIMO · Material/Procurement | `materials_bom`/`material_requirements`/`procurement_items` | ✅ | 无 | **Keep @QIMO** |
| **Budget Order（预算单）** | finance · Finance | `budget_orders` | ✅ 财务侧 | 与 QIMO order 是"派生"非"复制" | **Keep @finance**，但 **Reference** QIMO order id（停止 notes ILIKE 模糊匹配） |
| **Cost（实际）** | finance · Finance | `cost_items`/`budget_sub_documents`/`actual_invoices` | ✅ | QIMO order_cost_baseline=估算 | **Split**：估算 @QIMO，实际 @finance |
| **Profit / Margin** | finance · Finance | `order_settlements`/`profit_order_styles` | ✅ 结算 | QIMO profit_snapshots(forecast/live/final) | **Split**：forecast @QIMO(从 Quote)；**live/final 实际 @finance**；QIMO 的 live/final 应**读 finance**（停双轨利润真相） |
| **Invoice / Receivable(AR) / Payable(AP) / Payment** | finance · Finance | `actual_invoices`/`receivable_*`/`payable_*`/`supplier_payments` | ✅ | QIMO 无（仅脚手架） | **Keep @finance=企业 SoT** |
| **GL / Journal / 总账** | finance · Finance | `accounts`/`journal_*`/`gl_balances` | ✅ | 唯一 | **Keep @finance** |
| **Exchange Rate** | finance · Finance | `exchange_rates` | ✅ master | QIMO quoter 锁汇 | **Keep @finance=FX master**；QIMO 报价时 pin 快照(合法) |
| **Supplier** | finance + QIMO | finance `suppliers`(付款属性) / QIMO 采购 | 🟡 双方各半 | 重叠 | **Split-by-aspect**：采购/寻源身份 @QIMO Supplier 域；付款属性 @finance（引用同一 supplier id） |
| **Factory** | 三处 | ARAOS `factory_profiles` / QIMO / finance 字符串 | ❌ ARAOS 复制 | 重复 | **Archive @ARAOS**，Reference QIMO 制造真相 |
| **Follow-up / Rhythm / Risk / Tier** | ARAOS + QIMO | ARAOS `relationship_band`/`followup_*`/`customer_tier`/`customer_scores`；QIMO `customer_rhythm`/`customer_matters` | 🟡 双方 | 重叠（按阶段） | **Split-by-stage**：售前节奏 @ARAOS；成交后客户节奏/投诉 @QIMO |
| **Supplier/Customer 财务画像** | finance · Finance | `*_financial_profiles` | ✅ 派生 | — | **Keep @finance**（派生） |
| **Alerts** | 三处 | finance `alerts`/`financial_risk_events`；QIMO `system_alerts`；ARAOS 无统一 | 🟡 | 重复告警 | **Keep 各自域内**；企业级看板 Analytics 聚合(只读) |

---

## 3. Cross Repository Relationship（现状关系 + 诊断）

### 3.1 现状数据流（标注：✅打通 / 🔴断 / ♻️重复 / ↪️绕路）

```
ARAOS companies/deals
   │  赢单 confirmSample/confirmOrder → enqueueHandoff → metronome_handoffs(status=pending)
   │  🔴 断：METRONOME_WEBHOOK_URL 未设 → 永远 pending，赢单死在 ARAOS 库
   ▼
QIMO Quote (quoter_quotes)        ♻️ 重复：ARAOS quote_strategies + finance _cost_breakdown 各算一遍 margin
   │  ↪️ 绕路：convertQuoteToOrder 只是 URL 预填，无 DB 链
   ▼
QIMO Customer Order (orders) ✅ 企业订单真相（18 关卡 / Material / MP / Procurement 已贯通）
   │  ① webhook order.created/updated（+quotation）→ finance
   │  ② 🔴 风险耦合：finance 用 METRONOME_SUPABASE_SERVICE_KEY **直连 QIMO 库 SELECT orders**
   │  ③ finance 审批 → callback /api/integration/finance-callback ✅
   ▼
finance budget_orders / synced_orders
   │  ♻️ 重复：customers 按 name 自建(get_or_create_customer)；budget_order 按 notes ILIKE 模糊匹配 QIMO order_no
   │  ♻️ 重复：QIMO profit_snapshots vs finance order_settlements 两份利润真相
   ▼
finance GL / AR / AP / Payment ✅ 钱的真相（企业唯一总账）—— 但回款/利润不回流 QIMO
```

### 3.2 诊断小结
| 类别 | 具体 |
|---|---|
| ✅ **已打通** | QIMO 内部主链（订单→物料→采购→生产任务）；QIMO→finance 三通道（webhook/直连/callback）实际在跑。 |
| 🔴 **断了** | ① ARAOS→QIMO 赢单 handoff（桥在、开关关，赢单死胡同）；② finance 回款/结算利润**不回流** QIMO（QIMO 看不到真实收款）；③ ARAOS 无任何入站（QIMO 状态不回 ARAOS）。 |
| ♻️ **重复** | 客户三份(ARAOS companies / QIMO customers / finance customers，全 name 匹配)；订单三份(QIMO orders / finance budget+synced / ARAOS orders)；报价/成本/利润 margin 三处各算；factory/产品/汇率/告警/客户分级多份。 |
| ↪️ **绕路 / 脆弱** | finance **直连 QIMO 库**（service key 跨库读，封装破坏、最脆）；QIMO quote→order 仅 URL 预填；finance 靠 `notes ILIKE` 猜订单归属（改名即断）。 |

### 3.3 一句话定性
> **没有共享身份键 = 一切重复与脆弱的根因。** 三系统各自正确地拥有自己阶段的真相（ARAOS 漏斗、QIMO 订单、finance 账目），但**互相用名字字符串猜对方是谁**，于是被迫各存一份副本。集成的第一性原理动作 = **建立企业级 Customer ID + Order ID 脊柱**（详见 `04-Enterprise-Integration-Roadmap.md` Phase 0）。
</content>
