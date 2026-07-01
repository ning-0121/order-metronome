# 15 — 采购 → 财务同步契约（Supplier + Purchase Order）

> **Date**: 2026-07-01 · 采购 P2b。QIMO **emit** 供应商/采购单事件;财务系统在**其 repo** 实现 accept。
> **本文只是规范**;财务未实现前,QIMO 侧 `sendToFinanceSystem` 未配置即静默跳过,不影响采购主链。
> **复用现有通道**:`lib/integration/finance-sync.ts` → `POST {FINANCE_SYSTEM_URL}/api/integration/webhook`(HMAC-SHA256 + `x-api-key` + `x-webhook-signature`)。**不新建通道。**

---

## 1. 传输（现有 webhook 信封）
```
POST {FINANCE_SYSTEM_URL}/api/integration/webhook
headers: x-api-key: INTEGRATION_API_KEY · x-webhook-signature: HMAC-SHA256(body, INTEGRATION_WEBHOOK_SECRET) · x-source: order-metronome
body: { event, timestamp, source:'order-metronome', request_id, data, signature }
```
财务侧验签(复用与现有 order 同步相同的 key/secret),然后按 `event` 分发。

## 2. 事件 A：`supplier.upserted`（建/更应付主体）
`data`:
```json
{ "supplier_id":"uuid", "supplier_code":null, "name":"...", "main_category":"fabric",
  "payment_method":"T/T", "net_days":60, "bank_info":"...", "tax_id":"...",
  "status":"active", "updated_at":"..." }
```
财务 MUST：以 `supplier_id` **幂等 upsert** 应付主体;财务字段(payment_method/net_days/bank_info/tax_id)可能在业务先建时为 null,财务补全后 QIMO 会**再次 emit**(带全字段)→ 幂等更新。

## 3. 事件 B：`purchase_order.placed`（建应付 + 付款计划）
`data`:
```json
{ "po_no":"PO-20260701-001", "purchase_order_id":"uuid", "supplier_id":"uuid",
  "total_amount":12345.67, "currency":"RMB", "payment_terms":"...", "delivery_date":"2026-08-01",
  "order_refs":["<qimo order_id>"], "status":"placed", "placed_at":"..." }
```
财务 MUST：以 `po_no` **幂等**建应付单 + 付款计划(据 supplier `net_days` 排期);引用 `supplier_id`(应付主体)+ `order_refs`(挂 QIMO 订单)。**不重录采购单内容**;成本/付款真相归财务。

## 4. 回流（已有通道）
财务审批/付款结果 → `POST {QIMO}/api/integration/finance-callback`(现有,HMAC)。P2b 暂不新增回流字段;后续如需"付款完成→采购单标记"再扩 callback。

## 5. 幂等 / 安全 / 顺序
- 幂等键:`supplier_id`(供应商)· `po_no`(采购单)。重复 emit 安全。
- 验签必过;`request_id` 可去重防重放。
- 顺序:供应商先于采购单(采购单引用 supplier_id);财务若先收到 PO 而无 supplier,应容错(挂起或按 supplier_id 建占位主体)。

## 6. 环境
QIMO：`FINANCE_SYSTEM_URL` / `INTEGRATION_API_KEY` / `INTEGRATION_WEBHOOK_SECRET`(与现有 order 同步共用)。未配 URL → QIMO 静默跳过。

## 7. 残余
- 端到端待财务 repo 实现上述两 accept 分支。
- QIMO 侧 emit 为 upsert 后同步(await,当前未配置即瞬时跳过);高并发/可靠投递硬化(outbox/队列)留后续。
- `received`(到货金额)同步留后续(P2b+)。
