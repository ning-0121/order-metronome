# Phase 0c — ARAOS Handoff Queue Design（修正锁定版）

> **Status**: 🟡 设计。**不写代码 · 不执行 SQL · 不提交 · 不 push。** 先 migration 草案 → 审核 → 定稿 → 门禁 → 归档 → **再**写代码。
> **Date**: 2026-06-29 · 承接 `07-Phase-0b-Contract-API-Design.md` §D.2/§E · `09`（0b 实现）· `08`（contract 日志两表已上线 `9c8f0f5`）。
> **用户 2026-06-29 锁定规则（不可违背）**：删除一切 auto-approve / auto-convert · 0c 严禁写真相表 · 全部 pending · 匹配只出建议 · 人工审批才晋升 · 0c 不实现 conversion · scope=`handoff.write` · 幂等统一 `request_id` · 先 migration 后代码。

---

## 1. Phase 0c Architecture（修正版）

> **0c = Event Ingestion System，NOT Business Execution System。**

```
ARAOS  ──POST /api/contract/v1/handoff/araos──▶  QIMO Contract 层
                                                  │
   ① HMAC 验证（handoff.write scope, ±300s, body-hash 签名）
   ② 幂等：查 contract_request_log.request_id（命中→回放，不重复入队）
   ③ 入队：INSERT handoff_queue（status='pending'）          ← 唯一真相写入点之一
   ④ 匹配引擎：只产建议（qimo_customer_id 候选 + match_confidence + method），回填 handoff_queue
   ⑤ 记 contract_request_log（幂等回放体）+ contract_access_log（审计）
   ⑥ 返回回执 { success, handoff_id, status:'pending', match:{...} }
                                                  │
                            （到此为止。人工审批=后续；conversion=更后续，皆非 0c）
```

**写入白名单（0c 唯一允许写的三张表）**：`contract_access_log`（0b）· `contract_request_log`（0b）· `handoff_queue`（0c 新增）。
**只读（供匹配，绝不写）**：`customers`（`source_araos_company_id` / `customer_name` / `email` …）· `quoter_quotes` · `orders`。
**绝不写**：orders · customers · quoter_quotes · samples · 任何业务真相表。
**绝无**：auto-approve · auto-convert · 自动绑定 · 无审批 downstream。

### 1.1 需你点头的两处 0b 代码增量（纯增逻辑，不改表、不改现有读端点行为）
| 文件 | 增量 | 为什么必须 |
|---|---|---|
| `_lib/scopes.ts` | 加 `handoff.write`；保留 `finance.read` / `commercial.read` | araos 现在只有 `commercial.read`，写 handoff 需写 scope |
| `_lib/auth.ts` | ① 消费方 scope 由**单个**改为**集合**（araos = `[commercial.read, handoff.write]`，finance = `[finance.read]`）② POST 规范串追加 `\nsha256(body)` | 多 scope + POST 带 body 的签名 |
> 这是 0c 唯一触碰的 0b 代码，**不改 0a/0b 任何表、不改 4 个只读端点行为**。读端点的签名仍是 GET 无 body 规范串（保持兼容）。

---

## 2. handoff_queue Migration Design（先做，代码暂停）

> 新表，纯加法。流程：**草案 → 审核 → 定稿 `supabase/migrations/...` → 你执行 + DB 门禁 → 归档 → 才写代码**。
> 拟定稿文件名：`supabase/migrations/20260629_phase0c_handoff_queue.sql`。

```sql
-- DRAFT ONLY — 待审核后定稿；不执行
CREATE TABLE IF NOT EXISTS public.handoff_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),       -- 由 app 在 update 时显式写（无 trigger）
  -- 事件
  type             text NOT NULL CHECK (type IN ('deal_won','sample_request','quote_approved','customer_po_ready')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  -- 幂等（= contract_request_log.request_id 同一键；此处 UNIQUE 仅防重，不构成第二套幂等源）
  request_id       text NOT NULL,
  -- 业务去重（仅供人工识别"同一 deal 重复 handoff"，非唯一约束、不驱动幂等）
  business_key     text,
  -- ARAOS 来源 id（跨库留痕，非 FK）
  araos_company_id uuid,
  araos_deal_id    uuid,
  araos_order_id   uuid,
  araos_sample_id  uuid,
  -- 入站载荷（证据派生，非真相）
  payload          jsonb,
  -- 匹配建议（仅建议；空=未匹配；绝不据此绑定真相）
  qimo_customer_id uuid,
  qimo_quote_id    uuid,
  qimo_order_id    uuid,
  match_confidence numeric(4,3),       -- 0..1
  match_method     text,              -- deterministic | name_similarity | email_domain | phone | none
  -- 人工审批留痕（0c 不自动改；晋升=人工）
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  review_note      text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_handoff_queue_request_id ON public.handoff_queue (request_id);
CREATE INDEX IF NOT EXISTS idx_handoff_queue_status   ON public.handoff_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_queue_company  ON public.handoff_queue (araos_company_id);
CREATE INDEX IF NOT EXISTS idx_handoff_queue_business ON public.handoff_queue (business_key);
ALTER TABLE public.handoff_queue ENABLE ROW LEVEL SECURITY;  -- service-role 写；审批 UI 的 read/update 策略留后续阶段

COMMENT ON TABLE public.handoff_queue IS
  'Phase0c: ARAOS handoff 入站队列。Event ingestion only — 一律 pending，匹配只产建议，人工审批才晋升；0c 绝不写 orders/customers/quoter_quotes 等真相表、不做 conversion。service-role 写，RLS 默认拒绝。';
COMMENT ON COLUMN public.handoff_queue.request_id IS '幂等键（= contract_request_log.request_id，唯一来源）；本表 UNIQUE 仅防重，不构成第二套幂等。';
COMMENT ON COLUMN public.handoff_queue.match_confidence IS '匹配建议置信度 0..1；仅供人工排序/参考，绝不据此自动绑定或晋升。';
COMMENT ON COLUMN public.handoff_queue.qimo_customer_id IS '匹配引擎建议的 QIMO customers.id；建议值，非绑定（人工审批前不视为真相关系）。';
```

**设计要点**：
- `status` CHECK 只含 `pending/approved/rejected`——**`converted` 不在 0c**（conversion 是后续阶段，届时再 widen CHECK）。
- `request_id` UNIQUE = 防重护栏；**幂等的权威判定在 `contract_request_log`**（先查它，命中即回放，不进本表）。
- 匹配建议字段全可空、默认无；`source_araos_*` 同款红线——**trace/建议，不作业务判断/绑定依据**。
- RLS 启用 + 0 策略（service-role 写）；审批 UI 的 read/update 策略**留后续阶段**（0c 无 UI）。

> 门禁项（10 项，与 0b 同构）：① 表存在 ② 列+类型（约 19 列）③ PK=id + status/type CHECK 存在 ④ RLS=true/policy=0 ⑤ 索引（uq_request_id 唯一 + status/company/business 三个）⑥ 表/列注释 ⑦ **无跨表 FK** ⑧ 初始 0 行 ⑨ 默认拒绝 ⑩ 无 ALTER 现有表。验证 SQL / 回滚 SQL 在定稿文件里附（同 0b 形态）。

---

## 3. API Design — `POST /api/contract/v1/handoff/araos`

- **Auth**: HMAC（`handoff.write` scope；araos key）。POST 规范串 = `method\npath\ntimestamp\napiKey\nsha256(body)`；±300s 窗口。
- **Request schema**（承 doc 07 §D.2）:
```jsonc
{ "request_id":"uuid(幂等键, 必填)",
  "type":"deal_won|sample_request|quote_approved|customer_po_ready",
  "araos":{ "company_id":"uuid","deal_id":"uuid?","order_id":"uuid?","sample_id":"uuid?","strategy_id":"uuid?" },
  "company_name":"...(仅匹配建议, 非真相)",
  "contact":{ "name":"?","email":"?","phone":"?" },
  "payload":{ /* 沿用 araos buildSample/OrderPayload 形状 */ } }
```
- **流程**：① 验签/scope ② 查 `contract_request_log.request_id`：命中→**回放首次回执**（`idempotent_replay:true`，不重复入队）③ 否则 INSERT `handoff_queue`（pending）+ 算 `business_key`（如 `type:coalesce(deal_id,order_id,sample_id)`）④ 跑匹配引擎回填建议 ⑤ 记 `contract_request_log` + `contract_access_log`。
- **Response (202)**:
```jsonc
{ "schema_version":"v1", "success":true, "handoff_id":"uuid",
  "status":"pending",                               // 永远 pending（匹配不改状态）
  "idempotent_replay":false,
  "match":{ "qimo_customer_id":"uuid|null", "match_confidence":0.0, "match_method":"deterministic|name_similarity|email_domain|phone|none" } }
```
- **错误码**：401 `invalid_signature` · 401 `timestamp_expired`（语义=expired_request）· 403 `insufficient_scope`（语义=forbidden_scope）· 409 `conflict`（同 request_id 不同 body）· 422 `invalid_payload` · 重复(同 request_id 同 body)→**回放**首次回执。
  > 沿用 0b 既有错误码名（invalid_signature/timestamp_expired/insufficient_scope），不另起一套，保持 contract 层一致。
- **写入**：仅 `handoff_queue` + `contract_request_log` + `contract_access_log`。**绝不**写 orders/customers/quotes/samples。

---

## 4. Matching Design（只出建议，绝不绑定）

> 匹配结果**写进 handoff_queue 的建议字段**，**永不**写 customers/orders/quotes、**永不**自动绑定。`match_confidence` 仅供人工参考/排序。

| 层级 | 规则 | confidence | method |
|---|---|---|---|
| **确定性** | `araos.company_id` → 查 QIMO `customers WHERE source_araos_company_id = araos.company_id` | 命中 = **1.0** | `deterministic` |
| 回退① 名称 | `company_name` 规范化（去空格/大小写/Co.,Ltd 归一）→ 与 `customers.customer_name/company_name` 相似度 | 0.60–0.85 | `name_similarity` |
| 回退② 邮箱域 | `contact.email` 域 → 匹配 `customers.email` 域 | 0.50–0.70 | `email_domain` |
| 回退③ 电话 | `contact.phone` 规范化 → 比 `customers.phone` | 0.50–0.70 | `phone` |
| 无匹配 | 无任一命中 | 0 | `none` |

- 只有**确定性未命中**时才跑回退；多个回退取最高分。
- `qimo_quote_id`/`qimo_order_id`：入站时 QIMO 多半还没有对应 quote/order → **通常为 null**（仅在有确定性链接时填）。0c 匹配**聚焦 customer**。
- **红线**：匹配是"建议"，不是"判定"。是否采用、是否新建客户/订单，**全由后续人工审批 + 人工晋升决定**（呼应 0a `source_araos_*` "external trace only" 与 Constitution 06）。

---

## 5. Approval State Machine（无 Conversion）

```
            ┌──────────────────────────────────────────────┐
 ingest ──▶ │  pending  │  ← 入站永远落这里；匹配只填建议，不改状态  │
            └─────┬─────────────────┬──────────────────────┘
       人工 approve │         人工 reject │
                  ▼                 ▼
            ┌──────────┐      ┌──────────┐
            │ approved │      │ rejected │   ← 0c 的两个终态
            └────┬─────┘      └──────────┘
                 ╎ （后续阶段 · 人工发起 · 走现有订单起源流程）
                 ▼
            [ Conversion → 写真相表 ]   ❌ 不在 0c
```
- **0c 实现**：入站建 `pending` + 匹配。状态转移**逻辑**（`approval.ts`：允许 `pending→approved` / `pending→rejected`，**禁止**任何 `→converted`）+ 守卫。
- **转移触发面（谁点 approve/reject）= 人工，经 QIMO 会话鉴权的审批入口**——该入口（UI/route）属**后续阶段**，0c 不建 UI。
- `approval.ts` 若提供 approve/reject 执行，**只 UPDATE `handoff_queue.status` + reviewed_by/at**，**绝不**触及真相表；`approved` 是 0c 终态，conversion 不在 0c。
- **无任何自动转移**：没有 system 改 pending、没有 system 写真相。

---

## 6. Coding Plan（migration 门禁 PASS 后才动）

### 文件级（新增为主 + 2 处 0b 增量）
| 文件 | 动作 | 说明 |
|---|---|---|
| `_lib/scopes.ts` | **改(增)** | 加 `handoff.write`；`canSeeFinancials` 不变 |
| `_lib/auth.ts` | **改(增)** | 消费方多 scope；POST 规范串加 body-hash；GET 行为不变 |
| `app/api/contract/v1/handoff/araos/route.ts` | 🆕 | POST 入站（withContract 包装，requiredScope=handoff.write，POST 变体）|
| `_lib/handoff.ts` | 🆕 | 入站编排：查 request_log 幂等 → 插 handoff_queue(pending) → 调 matching → 写 request_log/回执 |
| `_lib/matching.ts` | 🆕 | 匹配引擎（确定性 + 回退；只读 customers/quoter_quotes/orders；只产建议）|
| `_lib/approval.ts` | 🆕 | 审批状态机（pending→approved/rejected 守卫；只 UPDATE handoff_queue；禁 conversion）|
| `_lib/withContract.ts` | **改(增, 可选)** | 支持 POST + 写入类（requiredScope + request_id 幂等钩子）；或在 handoff route 内联 |
| `scripts/test-contract-handoff.ts` | 🆕（最小，先说明）| tsx 单元：签名(POST body-hash)、scope=handoff.write、幂等回放、匹配建议、状态机守卫、**断言绝不写真相表** |

### 实现顺序（编码批准后）
1. （已先行）handoff_queue migration 门禁 PASS + 归档。
2. `_lib/scopes.ts` + `_lib/auth.ts` 增量（先单测：handoff.write、多 scope、POST body-hash 签名）。
3. `_lib/matching.ts`（纯函数 + 只读查询；单测确定性/回退/无匹配）。
4. `_lib/approval.ts`（状态机守卫；单测合法/非法转移、禁 converted）。
5. `_lib/handoff.ts` + `handoff/araos/route.ts`（入站编排 + 幂等回放）。
6. `scripts/test-contract-handoff.ts`（含"绝不写真相表"的断言）。
7. `npm run build && npm run check` → diff → 批 → push（纯新增 + 2 处 0b 增量）。

### 单元测试策略（tsx，无新框架）
- 复用 `node:assert`；只 import 无 `@/` 依赖的纯函数（auth/scopes/matching/approval 的纯部分）。
- 关键断言：handoff.write 通过 / commercial.read 调 handoff → 403 / 同 request_id 重放同回执 / 匹配只回填建议、`status` 仍 pending / 状态机拒绝 `→converted` / **mock supabase 断言只 from('handoff_queue'|'contract_*')、从不 from('orders'|'customers'|'quoter_quotes'|'samples')**。

### 边界（再确认）
不写真相表 · 无 auto-approve/convert · 无 conversion · 无 UI · 不改 0a/0b 表 · 不改 4 个只读端点行为 · 不接 finance · migration 先行 · 完成先给 diff 不直接 push。

### 边角处理
- `araos.company_id` 缺失 → 跳过确定性匹配，直接回退；全无 → `method='none'`、confidence 0、仍入队 pending。
- `request_id` 缺失 → 422（写入类必带）。
- 同 request_id 同 body 重放 → 回放首次回执（不新增队列行）。
- 同 request_id 不同 body → 409 conflict。
- 匹配多候选 → 取最高分；并列 → 标记 `method` 但**不自动选**（留人工）。
- DB 写失败 → 不产生对真相表的部分写（本就不写真相表）；handoff_queue 插入失败 → 返回 5xx，araos 凭同 request_id 安全重试（幂等）。

---

> **本文 = 设计。不写代码 / 不执行 SQL / 不提交 / 不 push。**
> 下一步（你批准设计后）：先把 §2 的 `handoff_queue` migration 出**定稿草案**给你审 → 你执行 + 跑门禁 → 归档 → 才进 §6 编码。
</content>
