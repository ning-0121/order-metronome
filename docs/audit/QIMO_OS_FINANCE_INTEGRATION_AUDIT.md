# QIMO OS Finance Integration Audit

## Scope and architecture

Finance is a separate repository, Vercel project and Supabase database. It includes receivables, payables, bank reconciliation, payment batches, order budgets, profit, settlement, tax, GL and a control center. Order Metronome exchanges signed events/snapshots rather than sharing financial tables.

## Controls found

- HMAC + API-key validation and mandatory five-minute timestamp window for signed integration requests.
- Source lineage types and integration request/callback/outbox records.
- Finance document execution requires authenticated `finance_staff`, `finance_manager` or `admin`; the server replaces client `confirmed_by` with authenticated `auth.userId`.
- AI action safety levels all set `auto_execute=false` and require confirmation.
- High-risk amount/currency fields, duplicate probability and confidence checks exist.
- GL/freeze/closing/integrity/submit-gate engines and Decimal.js are present.

## Findings

1. **P0-FIN-01 (contract continuity):** Order creation can succeed while Finance initialization/sync fails as non-blocking. Durable outbox exists for core integration, but the employee response does not prove the event is queued/reconciled. An Order may temporarily or indefinitely lack receivable/budget truth.
2. **P1-FIN-02 (provider governance):** Finance directly imports Anthropic in extractor, quote extractor, AI chat and batch routes. It has no QIMO provider-neutral Runtime, unified usage metadata or boundary gate.
3. **P1-FIN-03 (Agent authorization):** `/api/agents/run` requires authentication but no Finance/admin role. It writes risk/action rows. These are recommendation/audit rows rather than posted accounting truth, but any authenticated account can trigger scans and database writes.
4. **P1-FIN-04 (idempotency):** integration security includes an in-memory processed-request map. This is not a global serverless lock. Persisted callback/integration tables must enforce unique request IDs.
5. **P1-FIN-05 (document execution atomicity):** executor performs multiple actions with retries and updates audit/document states separately. Partial success is possible; rollback support is action-specific and needs transaction/reconciliation proof.
6. **P2-FIN-06:** `verifyOrigin` is implemented but not enforced. HMAC/API-key/timestamp are sufficient for authentication, but the unused configuration causes false operational confidence.
7. **P2-FIN-07:** Finance working tree contains pre-existing uncommitted SQL/exports/scripts. Audit did not modify or execute them.

## Business truth assessment

- Order amount/currency baseline: present, but delivery continuity needs outbox evidence.
- Procurement payable baseline: present with Finance approval separation.
- Shipment/receivable milestone: integration present; partial/retry golden test missing.
- Payment/settlement/GL: rich domain implementation; no live mutation test was allowed.
- AI financial writes: direct AI does not post autonomously through the documented executor; human Finance route gate is correct. The generic Agent scan still writes risk/action records and needs role/tool classification.

## Required tests

- duplicate signed webhook across two instances;
- out-of-order update and stale version;
- partial/over/refund/cancelled order handling;
- currency/Decimal precision and timezone cutoffs;
- document multi-action partial failure and replay;
- unauthorized Agent run and document execution;
- Order event queued when Finance is unavailable;
- reconciliation proves Order source reference to final receivable/payable/GL records.
