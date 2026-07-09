# QIMO OS — Phase 0 Integration Spine Design（身份脊柱详细设计）

> **Status**: 🟡 详细设计 + migration 草案 + API 契约草案。**不写代码 / 不执行 SQL / 不提交 / 不 push。**
> **Date**: 2026-06-29 · 遵守 Constitution / Development-Principles / DoD / EA V1.0/V1.1 / ADR · **Evolution NOT Rewrite**。
> **承接**: `01-Enterprise-Integration-Audit.md` · `02-Repository-Integration-Map.md` · `03-Cross-Repository-Object-Map.md` · `04-Enterprise-Integration-Roadmap.md`（本文 = Phase 0 的逐项展开）。
> **Phase 0 目标**: **建立三系统共享身份脊柱**——不迁移数据、不重写系统、不改业务流程、不合库、不引入跨库 FK。
> **Phase 0 范围（用户 2026-06-29 锁定，只此四件）**: ① **Identity Spine**（可空 id 列）· ② **Contract API**（只读 + handoff 入站 + 回流）· ③ **Handoff Queue**（ARAOS 赢单进 QIMO 人工确认队列）· ④ **Matching Report**（一次性回填匹配报表）。
> **Phase 0 明确不做**: ❌ Quote 重构 · ❌ Finance 重构 · ❌ UI 重构 · ❌ PO Compare · ❌ Production Work Order 改造。（这些属 EA V1.1 / 后续 Phase；Phase 0 只把接口"接到它们的入口"，不动其内部。）
> **本轮范围（用户批准）**: 设计 + migration 草案 + API 契约草案。**到此为止**。

---

## 0. Repository Discovery Report（已核实，非推测）

| Repo | Root Path（权威） | Branch | Commit | Supabase Project | 角色 |
|---|---|---|---|---|---|
| **QIMO OS** | `~/Library/Mobile Documents/com~apple~CloudDocs/order-metronome` | main | `3bd7c00` | `scrtebexbxablybqpdla` | **Enterprise Host（身份/状态提供方）** |
| **finance-system** | `~/Projects/财务系统` | main | `c446444` | `qpoboelobqnfbytugzkw` | 钱的真相（下游） |
| **clients-Hunters-OS (araos)** | `~/Projects/终极版客户开发系统/araos` | main | `db8f26c` | `hpdcqjfwmcbdlgywhjog` | 获客前端（上游） |

- **growth-os** = legacy / candidate，**本轮不纳入**（用户指示）。
- **order-metronome 权威副本** = CloudDocs 路径。`~/dev`、`~/Projects/order-metronome`、`~/order-metronome` 为**非权威副本**，不提交、不读为事实源（CLAUDE.md 2026-05-23 事故纪律）。
- 三库**独立 Supabase** → 物理上**无法建跨库 FK**（贯穿全文的硬约束）。

### 0.1 现状接缝（已读真实代码，作为 Evolution 依据）
| 接缝 | 现状（已验证） | 文件 |
|---|---|---|
| QIMO → finance 推送 | webhook `order.created/updated/activated`（**报价 quotation 内联随单推**）+ `price_approval`/`delay` | finance `src/app/api/integration/webhook/route.ts` |
| finance 镜像订单 | `synced_orders.id` **已 = QIMO `orders.id`**（同步路径 UUID 已共享）；新单 → `autoCreateBudgetDraft` | 同上 §handleOrderSync |
| finance 客户匹配 | `customers` 按 `ilike('company', '%name%')` 模糊匹配/自建 → **客户重复根源** | 同上 §autoCreateBudgetDraft |
| finance 预算单链 | `budget_orders` 靠 `order_no` + `synced_orders.budget_order_id` 链，**无显式 qimo_order_id** | 同上 |
| finance 直连 QIMO 库 | `METRONOME_SUPABASE_SERVICE_KEY` + `METRONOME_SUPABASE_URL` 跨库直读 orders（monitor/profit/dashboard/search）→ **最脆耦合** | finance `src/app/api/{monitor,profit,dashboard,search}` |
| finance 入站安全 | API Key + HMAC 签名 + 时间戳防重放 + 幂等（request_id） | finance `src/lib/integration/security.ts` |
| ARAOS → QIMO 桥 | `buildSamplePayload`/`buildOrderPayload`（用 `araos_sample_id`/`araos_order_id` + `company_name` 字符串）；`metronome_handoffs(entity_id, status: pending\|pushed\|error)` | ARAOS `lib/metronome/{payloads,client}.ts` |
| ARAOS 桥开关 | `METRONOME_WEBHOOK_URL` **未设 → 永远 pending**，赢单死在 ARAOS | ARAOS `lib/metronome/client.ts` |
| QIMO 回调入口 | `/api/integration/{finance-callback,sync-all,test-finance-health,test-finance-sync}` 已存在 | QIMO `app/api/integration/` |

> **一句话**：QIMO→finance 已三通道在跑、ARAOS→QIMO 桥已建但关着。**Phase 0 ≈ 给这些接缝补"共享 ID" + 拆掉 finance 直连库**，不是发明新管道。

---

## A. Identity Spine（身份脊柱）

> 原则：**每个企业身份只有一个生成者/拥有者（One Owner）；其余系统只引用，不自建。** QIMO 是 Enterprise Host，是大多数核心身份的权威。

| 企业身份 | 生成者（谁 mint） | 拥有者（SoT） | 引用者（存可空 id 列） | 物理来源 | 现状 |
|---|---|---|---|---|---|
| **qimo_customer_id** | QIMO（确认客户时）| QIMO `customers.id` (uuid) | finance、ARAOS | QIMO `customers` | 🔴 finance 名字自建 / ARAOS 独立 uuid |
| **qimo_quote_id** | QIMO（正式报价时）| QIMO `quoter_quotes.id` (uuid) | finance(forecast)、ARAOS(售前策略) | QIMO `quoter_quotes` | 🔴 三处各算 |
| **qimo_order_id** | QIMO（订单确认时）| QIMO `orders.id` (uuid) | finance、ARAOS | QIMO `orders` | 🟡 finance `synced_orders.id` 已=此值；budget_orders/customers 未接 |
| **qimo_product_id** | QIMO（建款时）| QIMO `products.id`（款）+ `product_variants.id`（变体） | finance、ARAOS | QIMO `products`/`product_variants` | 🔴 finance/ARAOS 自由文本 |
| **qimo_supplier_id** | **QIMO Supplier 域（尚未建表）** | 未来 QIMO Supplier 域 | finance(付款属性) | ⬜ **QIMO 暂无 supplier 主表** | ⚠️ 见下 |

### A.1 关于 qimo_supplier_id（用户 2026-06-29 拍板：延后 Phase 4，Phase 0 不处理 supplier identity）
- **现状**：QIMO **没有独立的 supplier 主数据表**（采购引用供应商，但 Supplier 域在 EA V1.0 标 ⬜ 待建）。finance `suppliers` 是目前最完整的供应商数据。**不能凭空生成供应商身份。**
- **Phase 0 处置**：**只声明所有权意图 + 预留语义，不新增活跃列、不做供应商回填。**
  - 所有权归属：未来 **QIMO Supplier 域（寻源身份）** 生成 `qimo_supplier_id`；finance `suppliers`（付款属性）引用同一 id（Split-by-aspect，见 `03-…` §7.4）。
  - **依赖**：`qimo_supplier_id` 的物理落地**依赖 QIMO Supplier 主表先建**（Roadmap Phase 4）。Phase 0 **不**给 finance/ARAOS 加 supplier 列，避免造一个没有权威来源的"空脊柱"。
  - 过渡期：供应商继续按现状 name 匹配，**显式排除在 Phase 0 回填之外**（§H）。
- **为什么这样**：Phase 0 的脊柱只立"有权威 mint 源"的身份（customer/quote/order/product）。supplier 无源 → 立了也是猜名字，违背脊柱的意义。

### A.2 ID 类型与生成约定
- 全部沿用各表现有 **uuid 主键**（QIMO customers/orders/quotes/products 均 uuid PK，已验证）。**不引入新的 ID 体系**——企业 ID = QIMO 既有 uuid，零成本。
- finance/ARAOS 引用列一律 **`uuid` 类型、可空、无 `REFERENCES`**（跨库不能 FK，见 §C）。
- 反向溯源：QIMO 侧也存**上游来源 id**（如 `orders.source_araos_order_id`），形成双向可追溯，但**不依赖**对方库存在（只是文本/uuid 留痕）。

---

## B. 每个仓库新增的可空字段（migration 草案 — 不执行）

> 全部 **`ADD COLUMN IF NOT EXISTS ... NULL`**：纯加法、幂等、可回滚（DROP COLUMN）、不改任何现有列语义、不加跨库 FK。
> ⚠️ 以下 SQL 为**草案**，仅供审阅。**不执行、不进 migrations 目录、不 push**。

### B.0 0a 定稿列集（用户 2026-06-29 锁定 — 共 15 列，不增不减）
| 库 | 列（表.列） |
|---|---|
| **finance-system**（4） | `customers.qimo_customer_id` · `budget_orders.qimo_order_id` · `budget_orders.qimo_quote_id` · `synced_orders.qimo_quote_id` |
| **clients-Hunters-OS**（6） | `companies.qimo_customer_id` · `deals.qimo_quote_id` · `orders.qimo_order_id` · `samples.qimo_order_id` · `metronome_handoffs.qimo_entity_id` · `metronome_handoffs.qimo_ack_at` |
| **QIMO OS**（5） | `quoter_quotes.customer_id` · `orders.origin_quote_id` · `customers.source_araos_company_id` · `orders.source_araos_order_id` · `orders.source_araos_deal_id` |
> ❌ **supplier 相关列一律不在 0a**（qimo_supplier_id 延后 Phase 4，§A.1）。❌ 早先草案的 `quoter_quotes.source_araos_strategy_id` 已移除。

### B.1 QIMO OS（Host — 5 列：2 本库引用 + 3 跨库 trace）
```sql
-- DRAFT ONLY — DO NOT RUN
-- 本库引用列(同 Supabase, 服务 EA V1.1; 0a 先加可空列, FK 约束延后):
ALTER TABLE public.quoter_quotes  ADD COLUMN IF NOT EXISTS customer_id            uuid;   -- 将接 customers.id(本库)
ALTER TABLE public.orders         ADD COLUMN IF NOT EXISTS origin_quote_id        uuid;   -- 将接 quoter_quotes.id(本库)
-- 跨库 external trace id(仅留痕, 绝不 REFERENCES, 见下红线):
ALTER TABLE public.customers      ADD COLUMN IF NOT EXISTS source_araos_company_id uuid;  -- ARAOS companies.id
ALTER TABLE public.orders         ADD COLUMN IF NOT EXISTS source_araos_order_id  uuid;   -- ARAOS orders.id
ALTER TABLE public.orders         ADD COLUMN IF NOT EXISTS source_araos_deal_id   uuid;   -- ARAOS deals.id
```
> **⚠ `source_araos_*` 使用红线（用户 2026-06-29 拍板）**：`source_araos_company_id` / `source_araos_order_id` / `source_araos_deal_id` 只是 **external trace id（外部溯源/审计指针）**，**不是业务关系 id**。
> - ❌ **不允许**作为任何业务判断、权限判定、金额勾稽、状态推进、查询归并的依据。
> - ✅ 只允许：审计追溯、人工核对、回填匹配诊断。
> - 业务关系一律走**本库** id（`quoter_quotes.customer_id` / `orders.origin_quote_id`）或经契约 API 实时获取的企业 id；跨库 trace 永不充当真相。
>
> 注：`quoter_quotes.customer_id` / `orders.origin_quote_id` 是**本库**引用（同 Supabase，FK 合法），同时服务 EA V1.1（Quote 接客户、Order 继承 Quote）。**0a 仅加可空列；FK 约束（`REFERENCES`）延后到 EA V1.1 接线时再加，保持 0a 纯加列、零约束/锁风险。** 移除了早先草案的 `quoter_quotes.source_araos_strategy_id`（不在定稿列集）。

### B.2 finance-system
```sql
-- DRAFT ONLY — DO NOT RUN
ALTER TABLE public.customers     ADD COLUMN IF NOT EXISTS qimo_customer_id uuid;   -- 引用 QIMO customers.id, 停 ilike 自建
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;   -- 引用 QIMO orders.id, 停 notes/order_no 猜
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;   -- 引用 QIMO quoter_quotes.id(forecast 来源)
-- synced_orders.id 已 = QIMO orders.id, 无需新增; 仅补来源报价 id 便于审计:
ALTER TABLE public.synced_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;
```
> finance `synced_orders.id` **已经**是 qimo order id（已验证），所以 Order 脊柱在 finance 侧"半成"。Phase 0 只需把 **budget_orders / customers** 接上 id，并把 `qimo_quote_id` 落到内联 `_cost_breakdown` 旁边。

### B.3 clients-Hunters-OS (araos)
```sql
-- DRAFT ONLY — DO NOT RUN
ALTER TABLE companies          ADD COLUMN IF NOT EXISTS qimo_customer_id uuid;  -- 赢单晋升后回填
ALTER TABLE deals              ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;  -- 售前策略 → QIMO 正式报价
ALTER TABLE orders             ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;  -- 薄订单 → QIMO 订单指针
ALTER TABLE samples            ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;  -- 打样 → QIMO 关联(可空)
ALTER TABLE metronome_handoffs ADD COLUMN IF NOT EXISTS qimo_entity_id   uuid;  -- QIMO 返回的对应 id(回执)
ALTER TABLE metronome_handoffs ADD COLUMN IF NOT EXISTS qimo_ack_at      timestamptz; -- QIMO 确认回执时间
```
> ARAOS `metronome_handoffs` 已有 `entity_id`(本地) + `status(pending|pushed|error)`；Phase 0 加 `qimo_entity_id` 存 QIMO 回执 id，让"推过去变成了谁"可追溯。

---

## C. 跨库不允许 FK —— 只能用 5 种连接（设计约束）

| 机制 | 用途 | Phase 0 落点 | 现状 |
|---|---|---|---|
| **Shared ID** | 三库用同一 `qimo_*_id` 互指 | §A/§B 的可空 uuid 列 | 🟡 半（synced_orders.id 已是） |
| **Webhook** | 事件推送（已有，加固） | QIMO→finance `order.*`；ARAOS→QIMO handoff | ✅ finance 入站 / 🔴 ARAOS 关闭 |
| **API Contract** | 只读拉取 + 反向回流（新） | §D 的 6 个契约（替代 finance 直连库） | ⬜ 新增 |
| **Event Bridge** | outbox 订阅（Phase 5 才全落，Phase 0 预留语义） | QIMO 关键事件 outbox | ⬜ 预留 |
| **Status Mapping** | 三库状态枚举互译 | §G 映射表 | ⬜ 新增 |

**铁律**：跨库引用列**永远是裸 uuid/text，绝不 `REFERENCES` 对方库**（物理不可能 + 会让一库 down 拖垮另一库）。引用完整性由**契约 API + 回填校验 + unresolved 队列**保证，不由数据库约束保证。

---

## D. QIMO Contract API 设计（契约草案 — 不写代码）

> 统一前缀 `/api/contract/v1/*`。**只读优先**；写入类（handoff/payment）单独鉴权。
> **安全复用 finance 已有方案**：API Key + HMAC 签名（`x-api-key` + `x-webhook-signature`）+ 时间戳防重放 + 幂等（`request_id`）。QIMO 侧需提供与 finance `lib/integration/security.ts` **对称**的校验。
> **版本化**：路径含 `v1`；响应含 `schema_version`。Breaking change 出 `v2`，旧版并存。

### D.1 三个只读身份契约
```ts
// DRAFT CONTRACT — 不是实现
// GET /api/contract/v1/customers/:qimo_customer_id
interface GetCustomerResponse {
  schema_version: 'v1'
  qimo_customer_id: string            // customers.id
  customer_name: string
  company_name: string | null
  country: string | null
  customer_code: string | null
  status: 'regular'|'vip'|'trial'|'inactive'
  source: { araos_company_id: string | null }
}

// GET /api/contract/v1/orders/:qimo_order_id
interface GetOrderResponse {
  schema_version: 'v1'
  qimo_order_id: string               // orders.id
  order_no: string
  qimo_customer_id: string
  origin_quote_id: string | null
  lifecycle_status: string            // QIMO 订单状态(见 §G)
  currency: string
  unit_price: number | null
  total_amount: number | null
  quantity: number | null
  style_no: string | null
  etd: string | null                  // 交期
  payment_terms: string | null
  incoterm: string | null
  // 报价快照(forecast 用):
  quotation: QuoteSnapshot | null
}

// GET /api/contract/v1/quotes/:qimo_quote_id
interface GetQuoteResponse {
  schema_version: 'v1'
  qimo_quote_id: string               // quoter_quotes.id
  quote_no: string
  qimo_customer_id: string | null
  style_no: string | null
  quantity: number
  // 成本构成(CAN_SEE_FINANCIALS 门控, 见 §I):
  total_cost_per_piece: number | null
  quote_price_per_piece: number | null
  margin_rate: number | null
  currency: string
  status: 'draft'|'reviewing'|'approved'|'won'|'lost'|'abandoned'
}
```

### D.2 入站：ARAOS 赢单交接
```ts
// POST /api/contract/v1/handoff/araos   (写入类, 需写权限 + HMAC)
interface UpsertHandoffFromARAOS {
  request_id: string                  // 幂等键
  type: 'deal_won'|'sample_request'|'quote_approved'|'customer_po_ready'
  araos: {
    company_id: string
    deal_id?: string
    sample_id?: string
    order_id?: string
    strategy_id?: string              // 售前报价策略
  }
  company_name: string                // 仅用于匹配建议, 非真相
  contact?: { name?: string; email?: string; phone?: string }
  payload: Record<string, unknown>    // 沿用现有 buildSample/OrderPayload 形状
}
interface UpsertHandoffResponse {
  status: 'queued_for_review'         // ★ 永不直接建真相, 进 QIMO 人工确认队列
  qimo_handoff_id: string             // 回执, ARAOS 存入 metronome_handoffs.qimo_entity_id
  matched_qimo_customer_id: string | null   // 系统给的匹配建议(待人工确认)
}
```
> **红线**：handoff **永不**直接创建 `customers`/`orders`。它只**入 QIMO 待确认队列**，人工确认后才晋升（Constitution 06 / `04-…` 路线原则 5）。

### D.3 finance 专用：拉订单快照 + 回流收款
```ts
// GET /api/contract/v1/finance/order-snapshot/:qimo_order_id   ← 替代 METRONOME_SUPABASE_SERVICE_KEY 直连库
//   = GetOrderResponse + 明细(order_line_items 摘要) + 当前里程碑阶段
interface FinancePullOrderSnapshot extends GetOrderResponse {
  line_items: { style_no: string; color: string; size_breakdown: Record<string, number>; qty: number }[]
  milestone_stage: string             // 当前 18 关卡阶段(供财务判断结算时点)
}

// POST /api/contract/v1/finance/payment-status   (finance → QIMO 反向回流, 写入类)
interface FinancePushPaymentStatus {
  request_id: string
  qimo_order_id: string
  actual_cost?: { material: number; processing: number; logistics: number; total: number; currency: string }
  settled_profit?: { gross_profit: number; gross_margin: number; currency: string }   // 结算利润(final)
  receivable?: { invoiced: number; received: number; outstanding: number; currency: string }  // AR
  as_of: string
}
interface FinancePushResponse { status: 'recorded'; profit_snapshot_type: 'live'|'final' }
```
> `financePushPaymentStatus` 落到 QIMO `profit_snapshots(live/final)` **只读缓存** + 客户目标达成回写——**消除双轨利润真相**（QIMO 不再自算 live/final，读 finance）。

---

## E. ARAOS → QIMO Handoff 设计（4 个触发）

> 现状：ARAOS 已有 `buildSamplePayload`/`buildOrderPayload`，桥因 `METRONOME_WEBHOOK_URL` 未设而关闭。Phase 0 设计**统一入口** `POST /api/contract/v1/handoff/araos`（§D.2），4 个触发用 `type` 区分，**全部进 QIMO 人工确认队列**。

| 触发 | ARAOS 侧事件/表 | payload（演进现有形状） | 进入 QIMO 的方式 | QIMO 落点（人工确认后） |
|---|---|---|---|---|
| **Deal Won** | `deals.stage=won` / `companies.account_status=won` | `type:'deal_won'` + deal/company/strategy id | handoff → **客户晋升队列** | 创建/关联 `customers`（写 `source_araos_company_id`）；ARAOS 回填 `companies.qimo_customer_id` |
| **Sample Request** | `samples.status=confirmed`（现有 `buildSamplePayload`） | `type:'sample_request'` + styles/qty/shipping | handoff → **打样队列** | 关联客户 + 建打样关联（可对接 Product 打样里程碑）；ARAOS 回填 `samples.qimo_order_id` |
| **Quote Approved** | ARAOS `quote_strategies` 定案（议价区间确定） | `type:'quote_approved'` + strategy + 目标价/margin 区间 | handoff → **正式报价队列** | 触发 QIMO 正式 `quoter_quotes`（成本/单耗/确认 → Approved Quote，EA V1.1）；ARAOS 回填 `deals.qimo_quote_id` |
| **Customer PO Ready** | ARAOS `orders`（薄，现有 `buildOrderPayload`）+ 客户 PO 文件 | `type:'customer_po_ready'` + order_ref/value/terms + PO 证据链接 | handoff → **订单确认队列**（对接 EA V1.1 PO Compare）| 预填 `orders`（写 `source_araos_order_id`/`origin_quote_id`）；经 PO Compare 人工确认；ARAOS 回填 `orders.qimo_order_id` |

**统一规则**：
- ARAOS 推送只携带 **id + 结构化字段 + 证据链接**，**不推文件本身**（Evidence≠Data，文件留 ARAOS 作证据）。
- QIMO 返回 `qimo_handoff_id` + 匹配建议 → ARAOS 存入 `metronome_handoffs.qimo_entity_id` / `qimo_ack_at`。
- **晋升=人工**：四类全部进队列待人工确认，AI 只给匹配/字段建议（Constitution 06 / DP-5）。
- 顺序对接 EA V1.1：Quote Approved → Customer PO Ready → PO Compare → 生产任务单（继承生成）。

---

## F. finance-system → QIMO 设计（拆直连 + 回流）

| 项 | 现状 | Phase 0 目标 | 机制 |
|---|---|---|---|
| **停止直连 QIMO 库** | finance 用 `METRONOME_SUPABASE_SERVICE_KEY` 跨库 SELECT orders（monitor/profit/dashboard/search）| **删除直连**，改调 `GET /api/contract/v1/finance/order-snapshot/:id` | API Contract（§D.3） |
| **正向推送（保留加固）** | webhook `order.created/updated`（quotation 内联）→ `synced_orders` + `autoCreateBudgetDraft` | 保留；`budget_orders` 改存 `qimo_order_id`/`qimo_quote_id`，**停 ilike 客户自建**（改存 `qimo_customer_id`） | Webhook（已有）+ Shared ID |
| **forecast 接 Quote** | finance 从内联 quotation 建 `_cost_breakdown` | 标注 `qimo_quote_id` 来源；QIMO 侧 Approved Quote → `profit_snapshots(forecast)` | Shared ID |
| **反向回流（新增，核心）** | finance 实际成本/结算利润/AR 收款**不回 QIMO** | `POST /api/contract/v1/finance/payment-status` → QIMO `profit_snapshots(live/final)` 只读缓存 + 客户目标达成 | API Contract（§D.3） |
| **审批闭环（保留）** | finance 审批 → QIMO `/api/integration/finance-callback` | 保留，payload 改带 `qimo_order_id` | Callback（已有） |

**finance 一句话**：**继续做钱；把"直连库"换成"拉快照契约"，把"名字猜客户"换成"qimo_customer_id"，把"实际成本/利润/收款"回流 QIMO。**

> ⚠️ **拆直连必须走"并行对账"硬流程（用户 2026-06-29 拍板，不得跳步）**：
> 1. **保留** `METRONOME_SUPABASE_SERVICE_KEY`（直连不动）。
> 2. **新增** Contract API `finance/order-snapshot`（只读、并行）。
> 3. finance **同时**读直连 DB 与 Contract API，**逐字段对账**（记录差异）。
> 4. **连续对账一致**（达到约定窗口/笔数、零未解释差异）后，**才允许**撤掉 service key（0d）。
> 5. 任一步异常 → 回退到直连（env 仍在），不影响线上。
> **禁止**：未经连续对账就撤 key；一刀切切换。

---

## G. Status Mapping（三库状态映射表）

> 三系统状态枚举互译。用于：handoff 推进、回流判断结算时点、企业看板统一口径。**各库内部枚举不改**，只在契约层做映射。

| 阶段 | ARAOS（获客） | QIMO（订单/生产） | finance（钱） |
|---|---|---|---|
| 线索/潜客 | `companies` discover/enrich/scored | —（QIMO 无） | — |
| 商机 | `deals.stage` = lead/contacted/negotiating | —（或 Inquiry 草稿） | — |
| 报价中 | `quote_strategies` 议价中 | `quoter_quotes.status=draft/reviewing` | — |
| 报价定案 | `quote_approved` | `quoter_quotes.status=approved`（Approved Quote） | — |
| **赢单** | `deals.stage=won` / `account_status=won` | （handoff → 待确认队列） | — |
| 打样 | `samples.status=requested/confirmed/in_production` | 产前样里程碑 | — |
| **订单确认** | `orders`(薄) pushed | `orders.lifecycle_status=confirmed`（PO Compare 后） | `synced_orders.lifecycle_status` 镜像 |
| 预算建立 | — | — | `budget_orders.status=draft` |
| 预算审批 | — | （finance-callback 回 QIMO） | `budget_orders.status=pending_review→approved/rejected` |
| 生产中 | （回流显示） | 18 关卡 阶段 A/B/C | `synced_orders.lifecycle_status` |
| 出运 | （回流显示） | `lifecycle_status=shipped`（出运完成） | 触发开票 |
| 开票/应收 | — | （回流缓存） | `actual_invoices` / `receivable_*` |
| **结算/回款** | `deals` 标记成交闭环（回流） | `profit_snapshots(final)` 读缓存 | `order_settlements` / 收款到账 |

**映射规则**：
- 映射表是**契约层翻译**，**不在任何库新增状态列**（Status Mapping 是代码常量/契约文档，不是表结构）。
- 三库各自的状态机**不变**；跨库只读"对方现在大致到哪一档"。
- 冲突时**以 Owner 域为准**（订单态以 QIMO 为准，钱的态以 finance 为准，获客态以 ARAOS 为准）。

---

## H. Backfill / Matching Strategy（一次性回填，人工兜底）

> 目标：把三库现存的客户/报价/订单补上 `qimo_*_id`。**只读匹配 + 生成报表，绝不自动覆盖高风险匹配**（DP-4 系统计算·人决策）。

### H.1 四级匹配（按对象）
| 对象 | Exact Match | Fuzzy Match | Manual Review | Unresolved Queue |
|---|---|---|---|---|
| **Order** | finance `synced_orders.id` == QIMO `orders.id`（**已天然对齐**，直接回填 budget_orders.qimo_order_id via synced_orders 链） | budget_orders 无 synced 链时：`order_no` 精确 → 再 `notes` 含 order_no | 金额/客户不一致 | 无 order_no 对应 |
| **Customer** | `customer_code` 精确 / 完全同名 | name 规范化后 trigram 相似度（去空格/大小写/Co.,Ltd 归一）| 相似度中等(0.6–0.85) → 人工 | 无任何匹配 |
| **Quote** | 已有 convertQuoteToOrder 链 / `style_no`+客户+数量精确 | style_no 模糊 + 时间窗 | 多个候选 | 无对应订单 |
| **Supplier** | **排除（Phase 0 不做，无 QIMO 权威源，见 §A.1）** | — | — | — |

### H.2 流程（一次性脚本，输出报表，不直接写生产）
```
1. 三库各自导出待匹配清单(只读)
2. 跑四级匹配 → 打分
3. 高置信(exact + fuzzy≥0.85) → 候选回填(待人工批量确认, 不自动 commit)
4. 中置信 → Manual Review 队列(逐条人工)
5. 无匹配 → Unresolved 队列(可能是真·新客户/孤儿单, 标记不强配)
6. 输出《回填匹配报表》: 三库 × 四级 计数 + 候选明细 + 冲突项
7. 人工审完 → 才执行回填(仍走数据库门禁: 验证 SQL 真返回 → PASS 才写)
```
- **不自动覆盖**：任何 `qimo_*_id` 写入前，高风险项必须人工核对（CLAUDE.md force-push 同型纪律：宁可慢，不可错配把 A 客户的单挂到 B）。
- **可重跑**：匹配幂等，新数据增量补；unresolved 不阻塞其他。

---

## I. Risk Control（红线，逐条保证）

| 红线 | Phase 0 如何保证 |
|---|---|
| **不影响线上** | 全部**可空列**（默认 NULL，现有读写无感知）；契约 API **并行只读**，撤直连前先比对验证；handoff 入队不碰真相表 |
| **可回滚** | 列回滚 = `DROP COLUMN`（纯加法天然可逆）；契约 API 撤回 = 关路由；finance 直连回滚 = 恢复 env；ARAOS 桥回滚 = 清空 `METRONOME_WEBHOOK_URL` |
| **不迁移数据** | 零表迁库；只在各库**原地加可空列** + 一次性**只读匹配报表**（回填是补 id，不是搬数据） |
| **不合库** | 三 Supabase 各自不动（`scrtebex…`/`qpoboel…`/`hpdcqjf…`）；联邦架构（`02-…` 顶层决策） |
| **不改主业务表含义** | 现有列**语义零改动**；新列全是"引用/溯源"附加信息；状态映射在契约层（不进表） |
| **不引入跨库 FK** | 跨库引用列一律裸 `uuid` 无 `REFERENCES`；完整性靠契约 + 回填校验 + unresolved 队列（§C 铁律） |
| **价格门控** | 契约 D.1 quote 成本/D.3 利润字段受 `CAN_SEE_FINANCIALS` 门控；不暴露给 production/merchandiser/admin_assistant |
| **AI 不跨系统写真相** | 匹配/晋升/回流全人工确认闸门（Constitution 06 / DP-5） |
| **iCloud 副本风险** | QIMO 一切以 CloudDocs 权威副本为准；migration 草案不进非权威副本 |

---

## J. Roadmap（Phase 0a–0e，逐子阶段）

> 每个子阶段独立可交付、独立可回滚；**先 ID 后契约后业务**（`04-…` 路线原则 4）。**本轮只到设计；每子阶段实施前仍走 DoD：设计审 → migration 草案 → 数据库门禁 → build+check → diff 审 → 批了才 push。**

| 子阶段 | 名称 | 内容 | 验收 | 风险 |
|---|---|---|---|---|
| **0a** | **身份字段** | 三库加 §B 可空列（migration 草案 → 门禁 → 执行）；QIMO 加本库 `quoter_quotes.customer_id`/`orders.origin_quote_id` | 列存在、默认 NULL、线上无感 | 极低（纯加法） |
| **0b** | **只读 Contract API** | QIMO 上 §D.1 三个只读契约 + §D.3 `finance/order-snapshot`（HMAC，对称 finance security）| finance 能用 qimo_order_id 拉到快照，结果与直连**比对一致** | 低（只读、并行） |
| **0c** | **ARAOS handoff 打开** | 设 `METRONOME_WEBHOOK_URL`；ARAOS 推送升级带 id；QIMO `handoff/araos` 入队 + 人工确认 UI | ARAOS 赢一单 → QIMO 出现待确认（不自动建真相）| 中（开关 + 队列，可关回） |
| **0d** | **finance 停止直连库（并行对账后）** | 走 §F 硬流程：保留 key → 加契约 API → 双读逐字段对账 → **连续一致才撤 key**。（注：仅替换"直连读 orders"这条集成管道；**不改 finance 客户匹配/预算逻辑/UI** —— 那是 Finance 重构，出 Phase 0） | 连续对账零未解释差异后撤 key，finance 监控/利润/看板全走契约仍正常 | 中（先并行验证再撤，可恢复 env） |
| **0e** | **回填匹配报表** | 跑 §H 一次性匹配 → 出报表 → 人工审 → 回填高置信 + 处理队列 | 存量客户/订单/报价可用同一企业 ID 三库互定位；unresolved 清单收敛 | 中（人工兜底，不自动覆盖） |

### J.1 与用户原 Phase 0a–0e 的对齐
用户原排：0a 身份字段 / 0b 只读 Contract API / 0c ARAOS handoff 打开 / 0d finance 停止直连库 / 0e 回填匹配报表 —— **完全一致，无需调整**。本设计只把每步落到**具体列 + 具体契约 + 具体验收**。

### J.2 Phase 0 完成的标志（Definition of Done）
1. 三库任一条客户/订单/报价，能用**同一个企业 uuid** 在另两库定位（不靠名字）。
2. finance **不再直连 QIMO 库**（service key 已撤）。
3. ARAOS 赢单**不再死在 pending**（进 QIMO 待确认队列）。
4. 全程**零表迁库、零合库、零跨库 FK、零线上中断**；任一子阶段可独立回滚。

---

## 附：Phase 0 边界（用户 2026-06-29 锁定）

**Phase 0 只做四件**：① Identity Spine · ② Contract API · ③ Handoff Queue · ④ Matching Report。

**Phase 0 明确不做**：
- ❌ **Quote 重构**（quoter_quotes 只加 `customer_id` 可空列，业务逻辑不动）。
- ❌ **Finance 重构**（只加 id 列 + 拆"直连读 orders"管道；客户匹配/预算/结算逻辑与 UI 全不动）。
- ❌ **UI 重构**（三系统现有页面零改；handoff 确认队列若需入口，最小化、不重构既有 UI）。
- ❌ **PO Compare**（属 EA V1.1，Phase 0 仅把 `customer_po_ready` handoff 接到其入口）。
- ❌ **Production Work Order 改造**（manufacturing_orders 不动）。
- ❌ 数据迁移 / 合库 / 跨库 FK / supplier 身份（§A.1 留 Phase 4）/ Event Bus 全量（Phase 5）。
- ❌ 写代码、执行 SQL、提交、push（本轮 = 设计 + 草案）。

> **下一步**：你审本设计。满意后，0a 的三库 migration 草案可分别落到各库的 migrations 目录（走各自数据库门禁），**QIMO 侧仍只在 CloudDocs 权威副本操作**。
</content>
