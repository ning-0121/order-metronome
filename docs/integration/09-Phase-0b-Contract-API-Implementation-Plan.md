# Phase 0b Contract API Implementation Plan（QIMO 只读端点实现计划）

> **Status**: 🟡 实现计划（设计）。**不写代码 · 不写 migration · 不提交 · 不 push。**
> **Date**: 2026-06-29 · 承接 `07-Phase-0b-Contract-API-Design.md`（契约）+ `08`（日志表已落 `9c8f0f5`）。
> **范围**: 仅 **QIMO OS 仓库**。实现 **4 个只读端点 + 安全框架 + access log 采集**。
> **不实现**（留 0c/0d）: `POST /handoff/araos` · `POST /finance/payment-status`。
> **真实依据**: finance `src/lib/integration/security.ts`（HMAC 方案，对称复用）· QIMO `lib/supabase/server.ts::createServiceRoleClient()` · QIMO App Router 路由约定（`app/api/integration/finance-callback/route.ts`）。

---

## 一、文件级计划

> **全部新增；零修改现有文件**（边界见 §七）。所有新增集中在 `app/api/contract/v1/` 之下。

### 新增文件
| 文件 | 职责 |
|---|---|
| `app/api/contract/v1/_lib/auth.ts` | 验 `x-api-key`→key_id+scope+secret；验 `x-signature`（HMAC 规范串）；验 `x-timestamp` 漂移窗口；恒定时间比较。返回 `{ok,keyId,scope}` 或 `{error_code,status}` |
| `app/api/contract/v1/_lib/scopes.ts` | scope 常量 + `requireScope(have,need)` + `canSeeFinancials(scope)` |
| `app/api/contract/v1/_lib/response.ts` | `ok(data)`（注入 `schema_version`）+ `fail(error_code,status)`（统一错误封套，无堆栈） |
| `app/api/contract/v1/_lib/log.ts` | `writeAccessLog(row)` → `contract_access_log`（service-role；best-effort try/catch；不存 body/财务原值） |
| `app/api/contract/v1/_lib/withContract.ts` | 高阶包装：auth → 执行 handler → 退出时写 access log → 错误映射。让 4 个 route 极薄、口径统一 |
| `app/api/contract/v1/customers/[id]/route.ts` | GET (1) customers |
| `app/api/contract/v1/orders/[id]/route.ts` | GET (2) orders |
| `app/api/contract/v1/quotes/[id]/route.ts` | GET (3) quotes |
| `app/api/contract/v1/finance/order-snapshot/[id]/route.ts` | GET (4) finance order-snapshot |

### 复用（只 import，不改）
- `@/lib/supabase/server` → `createServiceRoleClient()`（读业务表 + 写日志，绕 RLS）。
- Node `crypto`（`createHmac`/`timingSafeEqual`）——与 finance `security.ts` 同算法，但**契约层新写一份**（不改现有 `lib/integration/`）。

### 需要的环境变量（QIMO Vercel env；非文件改动）
| env | 用途 |
|---|---|
| `CONTRACT_KEY_FINANCE` / `CONTRACT_SECRET_FINANCE` | finance 消费方 key 令牌 + HMAC 密钥 |
| `CONTRACT_KEY_ARAOS` / `CONTRACT_SECRET_ARAOS` | araos 消费方 key 令牌 + HMAC 密钥 |
> 消费方（finance/araos）的**签名端**属各自仓库，**0b 不碰**（0c/0d 联调时接）。0b 仅实现 QIMO **验证端 + 端点**，用 QIMO 侧测试签名脚本自测。

### 不修改的文件（显式）
现有 `app/api/integration/*`、`lib/integration/*`、`lib/supabase/server.ts`、任何业务表/action/UI——**一律不动**。

---

## 二、安全实现

> 方向：finance/araos **签名**，QIMO **验证**（与 finance 现有 webhook 相反方向，算法对称）。GET 无 body，故 timestamp 走 **header** 不走 body。

### Headers（对齐用户命名）
| header | 含义 |
|---|---|
| `x-api-key` | 消费方令牌（标识 finance / araos；**非密钥本身**） |
| `x-timestamp` | unix ms |
| `x-signature` | hex(HMAC-SHA256) |

### HMAC payload string（规范串，canonical）
```
GET 端点（无 body）:
  signString = `${method}\n${pathWithQuery}\n${timestamp}\n${apiKeyToken}`
  signature  = HMAC_SHA256(secret_of_that_key, signString) → hex
（未来写入端点再追加 \n${sha256(body)}；0b 不涉及）
```
- 验证：`timingSafeEqual(Buffer(sig,'hex'), Buffer(expected,'hex'))`（恒定时间，防时序）——同 finance `verifySignature`。

### Key → scope → secret 注册表（多 key，区别于 finance 单 key）
| x-api-key 命中 | keyId | scope | secret |
|---|---|---|---|
| `CONTRACT_KEY_FINANCE` | `finance` | `finance.read` | `CONTRACT_SECRET_FINANCE` |
| `CONTRACT_KEY_ARAOS` | `araos` | `commercial.read` | `CONTRACT_SECRET_ARAOS` |
- key 匹配用 `timingSafeEqual`；命中后取该 key 的 secret 验签、取其 scope 控权。
- （写 scope `finance.write`/`handoff.write` 在 0c/0d 才用；0b 只读不涉及。）

### timestamp drift window
- `Math.abs(now - Number(x-timestamp)) > 300_000` → 拒绝（±300s，沿用 finance 5 分钟）。

### scope 判定
- `finance.read` → 可读 financial/cost 块、可访问 `finance/*` 端点。
- `commercial.read`（araos）→ 只读非财务摘要；访问 `finance/*` 端点 → **403**；读 orders/quotes 时 financial/cost 块降级为 `null`。

### request_id 对只读 API 是否可选
- **可选**。GET 天然幂等，**不要求** `request_id`；若消费方带了，仅落 access log 便于追踪，不参与幂等判定。（幂等存储 `contract_request_log` 是写入端点用的，0b 只读不写它。）
- 重放防护对读 = **timestamp 窗口 + 签名**即可（重放一个 GET 无副作用且受时间窗口约束）。

### auth 错误 → 错误码（详见 §五）
missing key→401 · 未知 key→401 · 错签名→401 · timestamp 过期→401 · scope 不足→403。

### 如何写 contract_access_log
- 由 `withContract` 在请求**退出时**（成功或失败）调用 `writeAccessLog`，service-role 写入；**best-effort**（try/catch 包裹，写日志失败**绝不**影响/阻断响应）。详见 §四。

---

## 三、数据读取（逐端点）

> 统一：service-role 读；响应顶层 `schema_version:"v1"`；按 scope 决定 financial/cost 块是否为 `null`；`finance/order-snapshot` 仅 finance scope。

### (1) GET `customers/[id]`
- **读表**: `customers`（按 `id = :qimo_customer_id`）。
- **返回**: `qimo_customer_id, customer_name, company_name, contact_name, country, customer_code, customer_type, source.araos_company_id`。
- **不返回**: `notes`、`created_at/created_by`、`email/phone`（PII，最小化——仅 contact_name；如确需 email 再单议）、其他客户。
- **scope 差异**: 无财务字段，两 scope 返回**相同**。
- **来源**: 全 `customers`；`source.araos_company_id` ← `customers.source_araos_company_id`（trace）。

### (2) GET `orders/[id]`
- **读表**: `orders`（按 `id`）。
- **返回**: `qimo_order_id, order_no, qimo_customer_id(←customer_id), origin_quote_id, lifecycle_status, style_no, etd, factory_date, incoterm, payment_terms` + `financial{currency,unit_price,total_amount,quantity}`。
- **scope 差异**: `financial` 块**仅 finance**；commercial → `financial:null`（降级，不报错）。
- **不返回**: `order_line_items`（用 (4) snapshot 取）、`created_by`、里程碑日志、`source_araos_*`（trace 不外泄）。

### (3) GET `quotes/[id]`
- **读表**: `quoter_quotes`（按 `id`）。
- **返回**: `qimo_quote_id, quote_no, qimo_customer_id(←customer_id), style_no, garment_type, quantity, status` + `cost{currency,exchange_rate,total_cost_per_piece,quote_price_per_piece,margin_rate}`。
- **scope 差异**: `cost` 块**仅 finance**；**araos 永得 `cost:null`**（成本/margin 真相不外泄到获客端）。
- **不返回**: `cmt_operations/cmt_factory`（工序/工厂深成本）、`fabric_*` 供应细节、训练/AI 原始、`notes`。

### (4) GET `finance/order-snapshot/[id]` —— **仅 finance scope**（commercial → 403）
- **是否 orders + line_items + quotation + milestone 摘要**: **是，四者皆含**。
- **读表**: `orders` + `order_line_items`（line_items）+ `quoter_quotes`（quotation，经 `orders.origin_quote_id`）+ `milestones`（投影 `milestone_stage`）+ `customers.customer_name`。
- **返回**: §(2) 全字段（含 financial）+ `customer_name` + `milestone_stage`（当前阶段粗粒度，如 `A/B/C/D-…`）+ `line_items[]{style_no,color,size_breakdown,qty}` + `quotation`（= §(3) cost 块）。
- **milestone_stage 投影规则**: 由该 order 的 `milestones` 推一个**当前阶段字符串**（如"最近未完成里程碑所属阶段"或"已完成阶段数→阶段标签"），**只给摘要，不返回逐条里程碑/审计**。
- **不返回**: 里程碑逐条日志、内部 user PII、`source_araos_*`。
- **对齐目的**: 字段一一覆盖 finance 现在**直连**读的那些（order_no/customer_name/lifecycle_status/currency/total_amount/unit_price/quantity/style_no/etd/payment_terms/incoterm + quotation）→ 0d 平替直连的前提。

### 绝不返回给 araos（commercial scope）
`cost/margin/total_cost/quote_price`、`order.financial` 块、`finance/order-snapshot` 全部、工序/工厂、service-only/internal-only（created_by、里程碑日志、source_araos_* trace）。

---

## 四、日志（contract_access_log）

| 维度 | 写什么 |
|---|---|
| **成功请求** | `outcome='ok'`、`status_code=200`、`key_id`(finance/araos)、`scope`、`method`、`route`(模板 `/api/contract/v1/orders/:id`)、`qimo_entity_type`、`qimo_entity_id`、`latency_ms`、`ip` |
| **失败请求** | `outcome`(unauthorized/forbidden/not_found/error)、`status_code`、`error_code`、`route`、`key_id`(已解析则 finance/araos，未解析则 `unknown`)、`latency_ms`、`ip` |
| **绝不写** | 请求 body、任何财务原值（price/cost/margin/amount）、真实密钥/签名、PII |
| **key_id** | 只写 `finance` / `araos` / `unknown`；**永不写** x-api-key 原值或 secret |
| **latency_ms** | `withContract` 进入记 `t0=Date.now()`，退出 `Date.now()-t0` |
| **写入方式** | service-role；**best-effort**（try/catch；日志失败不影响响应）；同步 await 但失败吞掉 |
| **request_id** | 读类可空；带了就记 `contract_access_log.request_id`，否则 NULL |

---

## 五、错误码（统一封套）

> 响应体：`{ "schema_version":"v1", "error":{ "code":"...","message":"..." } }`；无堆栈、无内部细节。

| HTTP | code | 触发 |
|---|---|---|
| 401 | `missing_api_key` | 无 `x-api-key` |
| 401 | `invalid_api_key` | `x-api-key` 不匹配任何已知 key（present-but-unknown；并入 401，避免枚举泄漏） |
| 401 | `invalid_signature` | `x-signature` 验签失败 |
| 401 | `timestamp_expired` | `x-timestamp` 缺失或漂移 > ±300s |
| 403 | `insufficient_scope` | scope 不足（araos 访问 `finance/*`） |
| 404 | `not_found` | 企业 id 不存在 |
| 500 | `internal_error` | 未捕获异常（通用，不泄内部） |
> （429 `rate_limited` 可选：沿用 finance 内存限流 120/min；0b 可先不加，量级低。）
> 注：`invalid_api_key` 是对用户清单的补充（present-but-unknown 情形），仍属 401 家族。

---

## 六、测试计划

| 类 | 用例 | 期望 |
|---|---|---|
| 鉴权 | 无 `x-api-key` | 401 `missing_api_key` |
| 鉴权 | 错签名 | 401 `invalid_signature` |
| 鉴权 | 过期 `x-timestamp` | 401 `timestamp_expired` |
| 授权 | araos key 访问 `finance/order-snapshot` | 403 `insufficient_scope` |
| 脱敏 | araos key 访问 `quotes/:id` | 200，且 `cost=null`（无 cost/margin） |
| 脱敏 | araos key 访问 `orders/:id` | 200，且 `financial=null` |
| 正路径 | finance key 访问 `order-snapshot` | 200，含 orders+line_items+quotation+milestone_stage |
| 正路径 | finance key 访问 customers/orders/quotes | 200，含 `schema_version`，财务块有值 |
| 负路径 | 不存在 id | 404 `not_found` |
| 日志 | 每个请求（成功/失败） | `contract_access_log` 追加一行，且**无** body/财务原值 |
| 单元 | `_lib/auth` 规范串/timingSafeEqual/漂移窗口/scope 判定 | 纯函数单测通过 |
| 回归 | 现有 `/api/integration/*` 冒烟 | 不受影响 |
| 闸门 | `npm run build && npm run check` | 必须通过 |

**测试形态**: 单元测 `_lib`（纯函数）；端到端用 `scripts/test-contract-api.ts`（QIMO 侧自签名请求打本地 dev server，覆盖上述用例）；finance/araos 真实签名端联调在 0c/0d。

---

## 七、边界（确认）

- ❌ 不写 migration（日志两表已在 0b migration 落地 `9c8f0f5`，本阶段不再动库）。
- ❌ 不改业务表 · ❌ 不改现有 `/api/integration/*` · ❌ 不改 `lib/integration/*`。
- ❌ 不改 finance 仓库 · ❌ 不改 araos 仓库。
- ❌ 不接 ARAOS handoff（`POST /handoff/araos` 不实现）· ❌ 不拆 finance 直连（`payment-status` 不实现、service key 不撤）。
- ❌ 不写 UI。
- ❌ **本轮不提交、不 push**——先给设计 + 文件级计划，等你审。
> 编码批准后才动手，且仍走：设计审 → build+check → diff 审 → 批了才 push。**新增端点纯加法，不碰任何现有线上路径。**

---

## 八、实现顺序（编码批准后）
1. `_lib/auth.ts` + `scopes.ts` + `response.ts`（先单测：规范串/验签/漂移/scope）
2. `_lib/log.ts` + `_lib/withContract.ts`（access log 采集 + 高阶包装）
3. (1)(2)(3) 三个只读 route（scope 降级财务块）
4. (4) `finance/order-snapshot`（字段对齐 finance 直连；finance-only）
5. `scripts/test-contract-api.ts` 自签名端到端 + 单测
6. `npm run build && npm run check` → diff 审 → 批准 → push（**纯新增**）

> 本文 = 实现计划。**不写代码 / 不写 migration / 不提交 / 不 push。** 等你审。
</content>
