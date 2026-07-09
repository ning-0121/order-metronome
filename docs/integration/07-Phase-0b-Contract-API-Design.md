# QIMO OS — Phase 0b Contract API Design（只读契约层 + 写入契约 + 并行对账）

> **Status**: 🟡 设计。**只做设计 · 不写代码 · 不写 migration · 不提交 · 不 push。**
> **Date**: 2026-06-29 · 承接 `05-Phase-0-Integration-Spine-Design.md` §C/§D/§F · `04-…Roadmap` Phase 0b/0d · Phase 0a 已落地（QIMO `ffdc602` / finance `fc352cf` / araos `257e8bb`）。
> **前提**: 三库各自独立 Supabase（QIMO `scrtebex…` / finance `qpoboel…` / araos `hpdcqjf…`），物理无跨库 FK；身份脊柱 15 列已上线（全 NULL，待 0e 回填）。
> **本文目标**: 设计 QIMO 作为 Enterprise Host 对外暴露的 **Contract API**——让 finance/araos 用企业 uuid 读取/提交，**取代 finance 跨库直连**。0b 只设计，编码留后续。

---

## 一、API 总原则

| # | 原则 | 落地 |
|---|---|---|
| 1 | **QIMO = Enterprise Host** | 客户/订单/报价的企业真相只在 QIMO；对外只暴露**契约**，不暴露库。 |
| 2 | **finance/araos 只能经 Contract API 读/写** | 不再有第二条通路；现存 webhook（QIMO→finance 推）保留，但**反向读取**一律走契约。 |
| 3 | **禁止再跨库直连** | finance 的 `METRONOME_SUPABASE_SERVICE_KEY` 直读 orders → 0d 经并行对账后撤除（见 §六）。 |
| 4 | **全部 versioned** | 路径含 `/v1/`；breaking change 出 `/v2/`，旧版并存有废弃期。 |
| 5 | **response 必含 `schema_version`** | 每个响应体顶层 `schema_version:"v1"`，消费方据此解析。 |
| 6 | **写入类必支持幂等** | `request_id` 为幂等键；重放返回首次结果（带 `idempotent_replay:true`）。 |
| 7 | **安全复用 finance 现有方案** | API Key（`x-api-key`）+ HMAC 签名（`x-contract-signature`）+ timestamp 防重放（`x-contract-timestamp`）+ `request_id` 幂等——与 finance `src/lib/integration/security.ts` **对称**。 |

### 总体形态
```
                    ┌──────────── QIMO OS (Enterprise Host, scrtebex) ────────────┐
                    │  app/api/contract/v1/*   ← 新增, 受 HMAC+Key+scope 门控       │
                    │  ┌── 只读 ──┐         ┌── 写入 ──┐                            │
 finance (qpoboel) ─┼─▶ customers/orders/   handoff/araos        ◀── araos (hpdcqjf)│
 araos   (hpdcqjf) ─┼─▶ quotes/finance-      finance/payment-     ◀── finance        │
                    │   order-snapshot       status                                 │
                    └────────────────────────────────────────────────────────────┘
   现存(保留): QIMO→finance webhook 推送 · QIMO finance-callback 入口 · finance 直连(0d 前并行)
```

### Scope 模型（系统对系统，不用人类角色）
契约消费方是**系统**不是人，故权限按 **API Key 的 scope** 而非 `CAN_SEE_FINANCIALS` 人类角色：

| API Key | 持有者 | scope | 可见财务字段？ |
|---|---|---|---|
| `CONTRACT_KEY_FINANCE` | finance-system | `finance.read` + `finance.write` | ✅（成本/价/利润——finance 本就拥有钱的真相） |
| `CONTRACT_KEY_ARAOS` | araos | `commercial.read` + `handoff.write` | ❌（araos 是获客端，**不得**拿 QIMO 成本/margin 真相） |

> `CAN_SEE_FINANCIALS`（人类角色门控）仍用于 QIMO **自己的 UI**；契约层用 **scope** 等价表达"这个系统能不能看钱"。两者并行不冲突。

---

## 二、只读 API

> 通用：方法 `GET`；headers `x-api-key` / `x-contract-timestamp` / `x-contract-signature`（GET 的签名基于 `method+path+timestamp+key_id`，无 body）；响应顶层含 `schema_version`。路径参数为**企业 uuid**。

### 2.1 `GET /api/contract/v1/customers/:qimo_customer_id`
- **Request**: path `qimo_customer_id`(uuid)。无 body。Headers 同上。
- **Response (200)**:
```jsonc
{ "schema_version":"v1",
  "qimo_customer_id":"uuid", "customer_name":"...", "company_name":"...|null",
  "contact_name":"...|null", "country":"...|null", "customer_code":"...|null",
  "customer_type":"regular|vip|trial|inactive",
  "source":{ "araos_company_id":"uuid|null" } }
```
- **权限**: `finance.read` 或 `commercial.read`（两方都能读客户身份）。
- **字段来源**: 全部来自 QIMO `customers`（`source.araos_company_id` ← `customers.source_araos_company_id`，仅 trace）。
- **敏感字段**: 无财务字段。**不需要** CAN_SEE_FINANCIALS / finance scope。
- **不能返回**: `customers.notes`（内部备注）、`created_by`、任何 auth 用户 PII、其他客户数据（无列表，仅按 id）。
- **错误码**: 400(非法 uuid) / 401(鉴权失败) / 404(无此客户) / 429 / 500。

### 2.2 `GET /api/contract/v1/orders/:qimo_order_id`
- **Request**: path `qimo_order_id`(uuid)。
- **Response (200)**:
```jsonc
{ "schema_version":"v1",
  "qimo_order_id":"uuid", "order_no":"QM-...", "qimo_customer_id":"uuid",
  "origin_quote_id":"uuid|null",
  "lifecycle_status":"...", "style_no":"...|null",
  "etd":"date|null", "factory_date":"date|null",
  "incoterm":"...|null", "payment_terms":"...|null",
  // 仅 finance.read 可见(financial block):
  "financial":{ "currency":"USD", "unit_price":12.3, "total_amount":12300, "quantity":1000 } | null
}
```
- **权限**: `finance.read`（含 financial 块）或 `commercial.read`（`financial:null`）。
- **是否含敏感字段**: 是——`financial` 块（价/额/量）。**需要 finance scope**；`commercial.read`(araos) 拿到的 `financial` 恒为 `null`（不报错，字段降级）。
- **字段来源**: `orders`（order_no/lifecycle_status/style_no/etd/factory_date/incoterm/payment_terms/currency/unit_price/total_amount/quantity）；`qimo_customer_id` ← `orders.customer_id`；`origin_quote_id` ← `orders.origin_quote_id`。
- **不能返回**: `order_line_items` 明细（finance 用 §2.4 的 snapshot 取）、`created_by`/审计/里程碑日志、`source_araos_*`（trace，不外泄给第三方）。
- **错误码**: 400 / 401 / 403(scope 不足而显式请求 financial 时——见说明) / 404 / 429 / 500。

### 2.3 `GET /api/contract/v1/quotes/:qimo_quote_id`
- **Request**: path `qimo_quote_id`(uuid)。
- **Response (200)**:
```jsonc
{ "schema_version":"v1",
  "qimo_quote_id":"uuid", "quote_no":"QT-...", "qimo_customer_id":"uuid|null",
  "style_no":"...|null", "garment_type":"...", "quantity":1000,
  "status":"draft|reviewing|approved|won|lost|abandoned",
  // 仅 finance.read 可见:
  "cost":{ "currency":"USD","exchange_rate":7.2,
           "total_cost_per_piece":8.1,"quote_price_per_piece":12.3,"margin_rate":15.0 } | null }
```
- **权限**: `finance.read`（含 `cost`）或 `commercial.read`（`cost:null`）。
- **敏感字段**: 是——`cost`（成本构成/价/margin = QIMO 报价真相）。**需要 finance scope**。**araos 永不得拿 `cost`**（它有自己的售前策略；QIMO 真实成本不外泄到获客端）。
- **字段来源**: `quoter_quotes`（quote_no/style_no/garment_type/quantity/status/currency/exchange_rate/total_cost_per_piece/quote_price_per_piece/margin_rate）；`qimo_customer_id` ← `quoter_quotes.customer_id`。
- **不能返回**: `cmt_operations`/`cmt_factory`（工序/工厂明细=深成本机密）、`fabric_*` 供应细节、训练/AI 原始数据、`notes`。
- **错误码**: 400 / 401 / 404 / 429 / 500。

### 2.4 `GET /api/contract/v1/finance/order-snapshot/:qimo_order_id`
> **专供 finance**，**取代其直连 QIMO 库**（0d 撤 service key 的替身）。
- **Request**: path `qimo_order_id`(uuid)。可选 query `?include=line_items,milestone`（默认全含）。
- **Response (200)**:
```jsonc
{ "schema_version":"v1",
  "qimo_order_id":"uuid", "order_no":"QM-...", "qimo_customer_id":"uuid",
  "customer_name":"...", "lifecycle_status":"...", "milestone_stage":"A|B|C|D-...",
  "origin_quote_id":"uuid|null", "qimo_quote_id":"uuid|null",
  "currency":"USD","unit_price":12.3,"total_amount":12300,"quantity":1000,
  "style_no":"...","etd":"date|null","factory_date":"date|null",
  "incoterm":"...|null","payment_terms":"...|null",
  "line_items":[ {"style_no":"...","color":"...","size_breakdown":{"S":10,"M":30},"qty":40} ],
  "quotation":{ /* = §2.3 cost 块, forecast 用 */ } | null }
```
- **权限**: **仅 `finance.read`**（commercial.read → 403）。
- **敏感字段**: 是（全财务 + 明细）。**需要 finance scope**（等价 CAN_SEE_FINANCIALS）。
- **字段来源**: `orders` + `order_line_items`（line_items）+ `milestones`（milestone_stage 投影）+ `quoter_quotes`（quotation，经 `orders.origin_quote_id`）+ `customers.customer_name`。
- **不能返回**: 里程碑逐条审计日志、内部 user PII、`source_araos_*`。
- **错误码**: 400 / 401 / 403(非 finance scope) / 404 / 429 / 500。
- **对齐现状**: finance 现在直读的字段（order_no/customer_name/lifecycle_status/currency/total_amount/unit_price/quantity/style_no/etd/payment_terms/incoterm + quotation）**本响应一一覆盖**，保证可平替（见 §六对账字段）。

---

## 三、写入 API

> 通用：方法 `POST`；headers 同只读 + 签名基于 `method+path+timestamp+key_id+sha256(body)`；body 必含 `request_id`(幂等键)。**写入类一律不直接写"真相表"为既成事实——handoff 进队列待人工确认；payment-status 写只读投影缓存。**

### 3.1 `POST /api/contract/v1/handoff/araos`
- **用途**: araos 赢单/打样/报价定案/PO Ready → 交接到 QIMO（**Deal Won / Sample Request / Quote Approved / Customer PO Ready** 四类，见 `05` §E）。
- **Request schema**:
```jsonc
{ "schema_version":"v1", "request_id":"uuid(幂等键)",
  "type":"deal_won|sample_request|quote_approved|customer_po_ready",
  "araos":{ "company_id":"uuid","deal_id":"uuid?","sample_id":"uuid?","order_id":"uuid?","strategy_id":"uuid?" },
  "company_name":"...(仅匹配建议, 非真相)",
  "contact":{ "name":"?","email":"?","phone":"?" },
  "payload":{ /* 沿用 araos buildSample/OrderPayload 形状 */ } }
```
- **Response schema (202)**:
```jsonc
{ "schema_version":"v1", "status":"queued_for_review",
  "qimo_handoff_id":"uuid(回执)", "idempotent_replay":false,
  "matched_qimo_customer_id":"uuid|null(系统匹配建议, 待人工确认)" }
```
- **idempotency key**: `request_id`；重放→返回首次 `qimo_handoff_id` + `idempotent_replay:true`，**不重复建队列项**。
- **HMAC 校验**: 必过；`handoff.write` scope（araos key）。
- **失败重试语义**: 5xx/网络失败 → araos 可安全重试（同 `request_id` 幂等）；4xx（鉴权/校验）不重试。建议 araos 侧指数退避，`metronome_handoffs.status` 仍管自己的 pending/pushed/error。
- **业务落点**: 写入 QIMO **handoff 待确认队列**（新对象，**0c 才建表**；0b 仅定契约）。**绝不**直接写 `customers`/`orders`。
- **是否直接写真相表**: ❌ 否。**是否进人工确认队列**: ✅ 是（Constitution 06 / DP-5；晋升必人工）。
- **错误码**: 400(schema) / 401 / 403(scope) / 409(同 request_id 不同 body) / 422(payload 校验) / 429 / 500。
- **0b 边界**: 契约**设计完成**，但**不在 0b 打开**（araos 不接、队列表不建）——见 §七、§八时序（属 0c）。

### 3.2 `POST /api/contract/v1/finance/payment-status`
- **用途**: finance 把**实际成本/结算利润/收款(AR)** 回流 QIMO，写 `profit_snapshots(live/final)` 只读缓存 + 客户目标达成。
- **Request schema**:
```jsonc
{ "schema_version":"v1", "request_id":"uuid",
  "qimo_order_id":"uuid", "as_of":"timestamptz",
  "actual_cost":{ "material":0,"processing":0,"logistics":0,"total":0,"currency":"CNY" }?,
  "settled_profit":{ "gross_profit":0,"gross_margin":0.15,"currency":"CNY" }?,
  "receivable":{ "invoiced":0,"received":0,"outstanding":0,"currency":"USD" }? }
```
- **Response schema (200)**:
```jsonc
{ "schema_version":"v1", "status":"recorded",
  "profit_snapshot_type":"live|final", "idempotent_replay":false }
```
- **idempotency key**: `request_id`；重放→返回首次结果，不重复 upsert。（`profit_snapshots` 本就 `(order_id,snapshot_type)` 唯一，天然幂等友好。）
- **HMAC 校验**: 必过；`finance.write` scope。
- **失败重试语义**: 5xx 可重试（幂等）；4xx 不重试。`as_of` 旧于现存快照则忽略（防乱序覆盖）。
- **业务落点**: QIMO `profit_snapshots`（type=live/final，**只读缓存，QIMO 不自算 live/final**）+ 客户目标达成回写。
- **是否直接写真相表**: 🟡 写**投影/缓存表**（profit_snapshots 是投影，非业务真相表；钱的真相留 finance）。**不进人工队列**（数值回流，非晋升）。
- **错误码**: 400 / 401 / 403 / 404(无此 order) / 409 / 422 / 429 / 500。
- **0b 边界**: 契约**设计完成**；**实际撤 service key 不在 0b**（属 0d）。0b 可先把此端点建好供 finance 联调，但不依赖它撤直连。

---

## 四、Security Design

| 项 | 设计 |
|---|---|
| **API Key 管理** | 每消费方一把 key（`CONTRACT_KEY_FINANCE` / `CONTRACT_KEY_ARAOS`），存 QIMO env（Vercel secret）；key→scope 映射在服务端常量；**可轮换**（新旧并存灰度）；key 仅标识身份，不单独授权（须配 HMAC）。 |
| **HMAC 签名** | `signature = HMAC_SHA256(secret, `${method}\n${path}\n${timestamp}\n${key_id}\n${sha256(body|'')}`)`，放 `x-contract-signature`。secret 每 key 独立，**只在两端 env**，不随请求传输。复用 finance `security.ts` 同构算法。 |
| **timestamp 防重放** | `x-contract-timestamp`(unix ms)；服务端拒绝偏差 > **±300s** 的请求；配合幂等彻底防重放。 |
| **request_id 幂等** | 写入类必带；服务端落 **idempotency log**（request_id + 首次响应摘要 + TTL，如 7 天）；重放命中→回放首次响应。（0b 实现时需一张小表 `contract_request_log`，届时单独 migration。） |
| **IP allowlist** | **设计上可选、默认不启用**。理由：finance/araos 部署在 Vercel/Railway，**出口 IP 动态**（与 WeCom 微盘加白名单失败同因，见 memory `wecom-file-delivery`）→ IP 白名单不可靠。**以 HMAC+key+timestamp 为主**；如将来固定出口（NAT 网关）再加 allowlist 作纵深防御。 |
| **日志审计** | 每次调用落 `contract_access_log`（time/key_id/route/qimo_id/status/scope/ip/latency；**不存 body 敏感值**，只存摘要）。鉴权失败单独记（对齐 finance `integration_logs` 的 `auth.failed`）。 |
| **敏感字段脱敏** | financial 块仅 `finance.*` scope 返回；其余 scope 字段降级为 `null`（非报错，除 §2.4 finance 专属端点对非 finance 返 403）；响应**永不含** auth 用户 PII、service key、其他客户数据、工序/工厂深成本。 |
| **financial data access control** | 双闸：① scope（key 维度）② 端点维度（`finance/*` 路由硬性要求 `finance.read/write`）。araos key 即使请求 financial 字段也只得到 `null` 或 403。 |

---

## 五、Backward Compatibility

| 现存通路 | 0b 处置 |
|---|---|
| **finance webhook（QIMO→finance 推 order/quotation）** | **保留不动**。它是"推"，与契约"拉"互补；0b 不改 webhook（也属 §七 Out of Scope）。 |
| **finance 直连 QIMO DB（service key 读 orders）** | **0b 期间保留并行**：finance 同时跑直连 + 新契约，对账（§六）；**0b 不撤**，撤在 0d。 |
| **araos metronome handoff（出站桥, 现关闭）** | **0b 不打开**。handoff 契约设计完成，但 `METRONOME_WEBHOOK_URL` 仍不设、队列表不建——打开属 0c。 |
| **QIMO finance-callback / sync-all 等现有入口** | **保留**；后续逐步让其 payload 带 `qimo_order_id`（非 0b 必须）。 |
| **老接口不被打断** | 契约是**纯新增**路由（`/api/contract/v1/*`，clean slate，无现有 `app/api/contract`）；不改任何现有 route/表；消费方**自愿迁移**，旧路径继续可用直到对账通过。 |

---

## 六、Parallel Reconciliation Plan（针对 finance 0d）

> 目标：在**不撤** service key 的前提下，证明"新契约 = 旧直连"，连续达标后才允许 0d 撤除。

1. **双读**: finance 对每个 `qimo_order_id`，**同时**①旧直连 DB 查 ②新 `GET /finance/order-snapshot`，二者都取。
2. **对比字段**（逐字段 equal）:
   `order_no` · `qimo_customer_id`↔`customer_name` · `lifecycle_status` · `currency` · `total_amount` · `unit_price` · `quantity` · `style_no` · `etd` · `payment_terms` · `incoterm` · `quotation` 成本块。
3. **达标门槛**: 连续 **≥7 天**且 **≥N 次**（建议 N≥200 或覆盖全部活跃订单各≥1次）**字段级 100% 一致** → 允许撤 service key。（任一财务关键字段 total_amount/unit_price/quantity 出现 mismatch 即重置计时。）
4. **差异处理**: 出现 diff → **不撤 key、不自动改任何一边**；落 `contract_recon_diff`（order_id/field/old/new/at），告警，人工定因（多半是契约字段映射或时点差）→ 修契约 → 重置连续计数。
5. **差异报表**: 每日《Reconciliation Report》：总比对数 / 一致数 / 各字段 mismatch 计数 / 未覆盖订单 / 连续一致天数。报表 PASS 是 0d 撤 key 的**唯一放行条件**。
6. **撤除动作（0d，不在 0b）**: 报表连续达标 → finance 删 `METRONOME_SUPABASE_SERVICE_KEY` 直连代码 → 仅留契约。回滚 = 恢复 env（双读本就并存，零风险）。

---

## 七、Out of Scope（0b 明确不做）

❌ Quote 重构 · ❌ Finance 重构 · ❌ UI · ❌ PO Compare · ❌ Production Work Order 改造 · ❌ **打开 ARAOS handoff**（队列表不建、`METRONOME_WEBHOOK_URL` 不设）· ❌ **实际撤 service key**（仅设计并行对账，撤除属 0d）。
> 0b 交付物 = **契约设计 + （编码批准后）只读端点 + 对账框架**；写入端点设计完成但其**业务激活**留 0c/0d。

---

## 八、最后交付

### 8.1 API Contract 表
| # | Method · Route | 类型 | scope | 幂等 | 敏感/财务 | 落点 | 写真相? | 人工队列? |
|---|---|---|---|---|---|---|---|---|
| 1 | GET `/contract/v1/customers/:id` | 读 | finance/commercial | — | 否 | — | — | — |
| 2 | GET `/contract/v1/orders/:id` | 读 | finance/commercial | — | financial 块(仅 finance) | — | — | — |
| 3 | GET `/contract/v1/quotes/:id` | 读 | finance/commercial | — | cost 块(仅 finance) | — | — | — |
| 4 | GET `/contract/v1/finance/order-snapshot/:id` | 读 | **finance only** | — | 是(全财务+明细) | — | — | — |
| 5 | POST `/contract/v1/handoff/araos` | 写 | handoff(araos) | `request_id` | 否 | handoff 队列(0c 建表) | ❌ | ✅ |
| 6 | POST `/contract/v1/finance/payment-status` | 写 | finance.write | `request_id` | 是 | `profit_snapshots`(投影) | 🟡 投影 | ❌ |

### 8.2 Route Map
```
app/api/contract/v1/
├── _lib/                         (设计，编码期落地)
│   ├── verify.ts                 HMAC + key→scope + timestamp + request_id（对称 finance security.ts）
│   ├── scopes.ts                 finance.read/write · commercial.read · handoff.write
│   └── respond.ts                统一 schema_version + 错误码 + 脱敏
├── customers/[id]/route.ts       GET (1)
├── orders/[id]/route.ts          GET (2)
├── quotes/[id]/route.ts          GET (3)
├── finance/
│   ├── order-snapshot/[id]/route.ts   GET (4)  ← 替代直连
│   └── payment-status/route.ts        POST (6)
└── handoff/
    └── araos/route.ts            POST (5)  ← 契约就绪, 0c 才激活
现有保留: app/api/integration/{finance-callback,sync-all,test-finance-*}（不动）
```

### 8.3 Security Checklist
- [ ] 每 key 独立 secret，存 Vercel env，可轮换（新旧并存）
- [ ] HMAC_SHA256(method+path+timestamp+key_id+sha256(body)) 校验
- [ ] timestamp 偏差 > ±300s 拒绝
- [ ] 写入 `request_id` 幂等（idempotency log + TTL）
- [ ] key→scope 双闸；`finance/*` 端点硬性 finance scope
- [ ] financial/cost 块仅 finance scope；其余降级 null 或 403
- [ ] 响应永不含 auth PII / service key / 其他客户 / 工序工厂深成本
- [ ] `contract_access_log` 审计（摘要，不存敏感值）+ 鉴权失败单记
- [ ] 速率限制（沿用 finance 120/min 量级）
- [ ] IP allowlist 默认关（出口 IP 动态），固定出口后再加
- [ ] 版本化：路径 `/v1/` + 响应 `schema_version`

### 8.4 Implementation Sequence（编码批准后；本 0b 仅设计）
1. `_lib/verify.ts` + `scopes.ts` + `respond.ts`（对称 finance security，先单测）
2. 只读 (1)(2)(3) — 纯读现表，scope 降级财务字段
3. 只读 (4) finance/order-snapshot — 字段对齐 finance 直连
4. `contract_access_log` + `contract_request_log`（小 migration，走数据库门禁）
5. 写入 (6) payment-status → profit_snapshots（联调，不撤直连）
6. 写入 (5) handoff/araos **契约骨架**（返回 queued，但队列表 + 激活属 0c）
7. finance 端并行对账采集（§六）→ 出 Reconciliation Report
> 每步：设计审 → build+check → diff 审 → 数据库门禁(若涉表) → 批了才 push。

### 8.5 Test Plan
| 类 | 用例 |
|---|---|
| **鉴权** | 无 key→401；错签名→401；timestamp 过期→401；scope 不足→403（araos 调 finance/order-snapshot） |
| **契约/schema** | 每端点响应含 `schema_version`；字段类型/必填校验；快照 schema 回归 |
| **字段门控** | araos 读 orders/quotes → financial/cost 恒 null；finance 读 → 有值 |
| **幂等** | 同 `request_id` 重放 → 同结果 + `idempotent_replay:true`，无重复落库；不同 body 同 id → 409 |
| **写入落点** | handoff → 进队列(0c 后)、不写 customers/orders；payment-status → upsert profit_snapshots(live/final)，乱序 as_of 被忽略 |
| **负路径** | 不存在 id→404；非法 uuid→400；超量→429 |
| **对账** | 同一 order 直连 vs 契约逐字段比对脚本；注入 mismatch → 报表标红、计数重置 |
| **版本** | `/v1` 正常；伪造 `/v2` → 404/410；废弃期行为 |
| **回归** | 现有 webhook/finance-callback/sync-all 不受影响（冒烟） |

---

> **本文 = 设计。不写代码 / 不写 migration / 不提交 / 不 push。** 你审通过后，下一步才是"0b 只读端点编码"（仍先设计审→build+check→diff→门禁→批准）。
</content>
