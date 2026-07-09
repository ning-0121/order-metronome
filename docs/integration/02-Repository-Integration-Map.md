# QIMO OS — Repository Integration Map（仓库集成地图）

> **Status**: 🟡 集成方案（不写代码 / 不写 migration / 不改库 / 不提交 / 不 push）。**Evolution NOT Rewrite**。
> **本文 = 第四步**：每个仓库——哪些保留 / 迁移 / 继续独立域 / 只保留 UI / 哪个库继续用 / 哪个库迁入 QIMO。
> **前提（不可违背）**：三个独立 Supabase（`scrtebex…` / `qpoboel…` / `hpdcqjf…`）。**不合并数据库**（CLAUDE.md「绝不共用 Supabase，否则生产数据被污染」+ Evolution）。集成靠**身份脊柱 + 契约 API/事件**，不靠跨库 FK。

---

## 0. 顶层决策：宿主、边界、连接方式

| 决策 | 结论 | 理由 |
|---|---|---|
| **谁是企业宿主（Enterprise Host）** | **QIMO OS** | 它是订单到生产的编排核心，EA V1.0 的 13 域宿主，已是生产真相中枢。 |
| **三库合一吗** | **否，保持三库** | Evolution NOT Rewrite；三系统是价值链三阶段，各自独立部署/演进；合库 = 大迁移 + 污染风险。 |
| **靠什么连接** | **身份脊柱（共享 Customer ID / Order ID）+ 契约 API + 事件 outbox** | 跨 Supabase 无法 FK；现有耦合（finance 三通道、ARAOS handoff）就是要**升级成契约**的seam。 |
| **AI 横切** | 三系统各自的 LLM 能力保留；**AI 永不跨系统直接写真相**（Constitution 06 / DP-5） | 各域自治 + 人工确认闸门。 |
| **要立刻消除的危险耦合** | finance **直连 QIMO 库**（`METRONOME_SUPABASE_SERVICE_KEY` 读 orders）→ 换成 QIMO 契约 API/事件 | 跨库 service-key 直读破坏封装、最脆、最危险。 |

> **企业 OS 拓扑（目标）**：三个独立部署的系统 + 一层**集成契约**（Identity / Event / API）。不是一个巨石，是**联邦（Federation）**。

---

## 1. finance-system 集成映射

> 定位：**企业唯一"钱的真相"（Finance Domain）。继续独立部署、独立库、独立 UI。** 改的是"它怎么认得 QIMO 的客户/订单"，不是它的账。

| 处置 | 内容 | 说明 |
|---|---|---|
| **保留（Keep，独立域）** | GL（accounts/journal_*/gl_balances）、AR（receivable_payments+allocations）、AP（payable_records/supplier_payments）、actual_invoices、cost_items、order_settlements、profit_order_styles、exchange_rates、bank_*、tax_refunds、payroll_*、prepayments、控制中心/审计/SOT 引擎 | 这些是 finance 独有真相，QIMO 只有脚手架，**全部留在 finance**。 |
| **保留为 UI（Keep UI-only）** | finance 的 /dashboard /reports /control-center /gl /cashflow 等 | 财务团队的工作台，留在 finance 自己的 UI；企业级只读看板由 QIMO Analytics 聚合。 |
| **改为引用（Reference，不再克隆）** | `customers`（停止 `get_or_create_customer` 按 name 自建）→ 改存 `qimo_customer_id`；`budget_orders` / `synced_orders`（停止 `notes ILIKE` 模糊匹配）→ 改存 `qimo_order_id` | **核心改造**：finance 不再克隆客户/订单为独立真相，而是**引用 QIMO 的企业 ID**。镜像表可留作 cache，但键改为 id。 |
| **拆分保留（Split）** | Cost / Profit：QIMO 持 forecast（报价估算），finance 持 **live/final 实际 + 结算**。新增「finance→QIMO 实际成本/利润回流」契约 | 消除"两份利润真相"：QIMO 的 profit_snapshots(live/final) 改为**读 finance 回流值**，不自算。 |
| **迁移（Migrate）** | **无表迁库**（三库不合并） | 仅迁移"集成方式"：直连读库 → 契约 API。 |
| **数据库继续用** | finance Supabase `qpoboelobqnfbytugzkw` **继续使用，不动** | Evolution。 |
| **要替换的耦合** | `METRONOME_SUPABASE_SERVICE_KEY` 直连 QIMO 库 → **删除**，改用 QIMO 提供的 `GET /api/contract/orders/{id}` + 订单事件订阅 | Phase 0 优先项。 |
| **现有可复用 seam** | 已有 `/api/integration/{webhook,sync,approve}` + HMAC 安全（`security.ts`）| **不重造**，把它们升级为正式契约（加共享 id）。 |

**finance 一句话**：**继续做钱，停止克隆客户/订单，把"直连库"换成"契约"，把"实际成本利润"回流给 QIMO。**

---

## 2. clients-Hunters-OS（araos）集成映射

> 定位：**企业的获客前端 → 升级为 Commercial / Customer-Development / 售前 Quote 域。继续独立部署、独立库、独立 UI。** 它是漏斗顶端，QIMO 完全没有，**不能动其核心**。

| 处置 | 内容 | 说明 |
|---|---|---|
| **保留 + 升级为域（Keep→Upgrade）** | `companies`/`contacts`/`deals`/`customer_events`/`outreach_logs`/`conversations` → **Commercial / Customer-Development Domain**；`quote_strategies`+`pricing_config` → **售前 Quote（决策支持）子域** | ARAOS 升为企业的"客户开发 + 商业获客"域，QIMO 的 Customer 域向**前**延伸到这里。 |
| **保留（Keep，独有）** | 线索发现/爬取/富化（Apollo/RocketReach/ImportYeti）、外联邮件引擎（SMTP/IMAP）、reply intelligence、agent/queue 基础设施、intent signals | QIMO 完全没有，**纯增量能力**，全保留在 ARAOS。 |
| **升级为引用（Reference）** | `companies.account_status='active_customer'` 的确认客户 → 赢单时**晋升**写入 QIMO `customers`，本地存 `qimo_customer_id`；`samples`/`orders` 薄表 → 存 `qimo_order_id` 指针 | 确认客户/订单真相归 QIMO；ARAOS 保留指针 + 售前历史。 |
| **归档/降级（Archive）** | `factory_profiles`/`factory_certifications`/`factory_capabilities`（QIMO 制造真相的本地复制）；legacy `quotes`（被 quote_strategies 取代） | Reference QIMO 制造真相；legacy quote 表归档。 |
| **删除候选（Delete，谨慎）** | `orders` 表作为**独立订单真相**的意义删除（降级为 handoff 指针记录）；重复的 schema-drift（`samples` 在 001 & 003 双定义）需对齐 | 不删数据，删的是"它是订单真相"这一**语义**。先验证线上 schema。 |
| **数据库继续用** | ARAOS Supabase `hpdcqjfwmcbdlgywhjog` **继续使用，不动** | Evolution。 |
| **要打开的 seam** | `metronome_handoffs` + `lib/metronome/*` 出站桥 → **设 `METRONOME_WEBHOOK_URL` + 升级 payload 带共享 id**，赢单真实推入 QIMO | Phase 1 优先：赢单不再死在 pending。 |
| **要新增的 seam** | **QIMO→ARAOS 入站状态回流**（订单进展/收款 → 更新 deal/conversation 阶段）| ARAOS 当前零入站，销售看不到成交后进展。 |

**ARAOS 一句话**：**继续获客，把"确认客户/订单"晋升交给 QIMO，把关闭的赢单桥打开，并新增成交后状态回流。**

---

## 3. QIMO OS（宿主）集成映射

> 定位：**企业编排核心 + 集成契约的提供方。** 它对外暴露"我是谁"的身份与"现在到哪了"的状态。

| 处置 | 内容 | 说明 |
|---|---|---|
| **保留（Keep，全部）** | orders/order_line_items/materials_bom/material_requirements/procurement_items/manufacturing_orders/products/product_*/customers | 企业订单到生产真相，**零改动**。 |
| **新增：身份契约（Provider）** | 暴露 `customers.id` 为**企业 Customer ID**、`orders.id` 为**企业 Order ID**；提供 `GET /api/contract/customers|orders|quotes/{id}` 只读契约 API | 让 finance/ARAOS 引用 id 而非 name。 |
| **新增：晋升入口（from ARAOS）** | 接收 ARAOS 赢单 handoff → 人工确认 → 创建/关联 `customers` + 预填 `orders`（EA V1.1 的"从 Approved Quote 继承"在此对接） | ARAOS deal-won → QIMO order origination。 |
| **新增：事件 outbox（Provider）** | 订单/里程碑/收款关键事件 → 事件流，供 finance & ARAOS 订阅（替代 finance 直连读库） | Event Catalog 第 2 步落地。 |
| **新增：实际回流（from finance）** | 接收 finance 的实际成本/结算利润/收款 → 写 profit_snapshots(live/final) 只读缓存 + 客户目标达成 | 消除双轨利润真相。 |
| **Quote 收口** | quoter_quotes 升为企业**正式 Quote 真相**（EA V1.1）；接 ARAOS 售前策略（上游）+ 喂 finance forecast（下游） | 一份正式报价真相，三系统各取所需。 |
| **数据库继续用** | QIMO Supabase `scrtebexbxablybqpdla`（CloudDocs 权威副本）| ⚠️ 先消除 iCloud 多副本风险。 |

**QIMO 一句话**：**做企业身份与状态的提供方——对外发"我是谁/到哪了"，对内继续编排订单到生产。**

---

## 4. 三仓库处置总表（一页速查）

| 系统 | 保留（独立域） | 迁移 | 继续独立 | 只保留 UI | DB 继续用 | DB 迁入 QIMO |
|---|---|---|---|---|---|---|
| **finance-system** | GL/AR/AP/Invoice/Payment/Cost实际/结算利润/FX/税/工资 | 无表迁库，仅迁"集成方式" | ✅ 独立部署+域 | 财务工作台 UI | ✅ `qpoboel…` | ❌（引用 QIMO id，不迁表） |
| **clients-Hunters-OS** | 线索/公司/联系人/Deal/外联/售前报价策略 | 无表迁库 | ✅ 独立部署+域 | 销售获客 UI | ✅ `hpdcqjf…` | ❌（晋升写 QIMO，不迁表） |
| **QIMO OS** | 订单/产品/物料/生产任务/采购/正式Quote/确认客户 | — | ✅ 宿主 | 订单/生产 UI | ✅ `scrtebex…` | — |

> **三个 DB 全部继续用，零表迁库。** 集成 = 在三库之上加**身份脊柱 + 契约 + 事件**。这就是 Evolution：不动任何系统的内脏，只规范它们怎么互相称呼、怎么交接。

---

## 5. 关键架构判断（我的强意见）

1. **不要合库。** 联邦优于巨石：三系统部署节奏、团队、风险面都不同；CLAUDE.md 已有"绝不共用 Supabase"的血泪纪律。合库是 Rewrite，违宪。
2. **身份脊柱是一切的前置。** 在建任何新功能前，先让三系统能用**同一个 Customer ID / Order ID** 互指。没有它，集成永远是"猜名字"。
3. **先拆危险耦合，再加新功能。** finance 直连 QIMO 库（service key）是定时炸弹——任何 QIMO schema 变更都可能静默打断财务。Phase 0 就换契约。
4. **打开已存在的桥，别造新桥。** ARAOS→QIMO 的 handoff、finance 的三通道**都已存在**，只是关着或脆弱。集成 80% 是"把现有 seam 升级为契约"，不是发明新管道。
5. **Quote 一份正式真相，三个视角。** ARAOS 售前策略（要不要接、给什么 margin 区间）→ QIMO 正式报价（成本/单耗/价/确认）→ finance forecast（计划利润）。三处都叫 quote，但只有 QIMO 那份是**成交真相**，另两处是**上游策略**与**下游计划**。
</content>
