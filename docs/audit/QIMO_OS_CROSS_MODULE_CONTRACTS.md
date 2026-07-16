# QIMO OS Cross-Module Contracts

| Contract | Producer -> consumer | Payload truth / stable key | Retry and failure behavior | Audit result |
|---|---|---|---|---|
| Order -> lines/milestones | `createOrder` -> Order domain | order id/order no | early milestone failure compensates by deleting order | FAIL: later line initialization can fail without rolling back Order |
| Order lines -> BOM | line save/create -> `style-fabric-sync` | order/style/color/source | best effort; sync rows overwritten on later save | PARTIAL: deterministic but no durable recovery queue |
| Approved BOM -> MRP/procurement | BOM submit -> snapshot/plan/items | order + snapshot version/material key | snapshot/version and deterministic calculations | PASS in unit tests; live workflow pending |
| Procurement -> inventory | receipt -> inventory transaction/readiness | receipt/line/material key | currently best effort in several receipt paths | **P0:** accepted receipt can leave inventory/readiness stale |
| Purchase/receipt -> Finance | Metronome outbox -> Finance integration | request_id/source refs/timestamp | `finance-sync` durable outbox for core events | PARTIAL: not every caller exposes pending state; some only warn |
| Production -> milestones/QC | dispatch/report -> milestone transitions | order/step/report | several transitions are non-blocking | PARTIAL: operational event can succeed while milestone/QC trigger remains stale |
| QC -> Shipment | inspection/release -> shipment gates | order/inspection/approval | distributed actions | UNPROVEN: no centralized test demonstrates every shipment path honors QC hold |
| Shipment -> Finance | shipment batch/milestone -> finance event | batch/order/request id | fire-and-forget wrappers with internal outbox expected | PARTIAL: requires replay/reconciliation test |
| Order -> Finance | order create/update/activate -> Finance | order id/event/request id | failures should enter `integration_outbox` | PARTIAL: Order creation success does not surface Finance pending state |
| Finance -> Order | callbacks/progress/approvals | signed request + source id | HMAC/API key/timestamp, callback events | PASS design; memory-only idempotency helper is not global across serverless instances |

## Contract standard

Each business-critical contract must have: canonical schema/version, producer-owned source id, idempotency key persisted in a database, compare-and-set consumer write, bounded retry, dead-letter/reconciliation queue, employee-visible pending/failure owner and audit evidence.

## Critical findings

- **P0-CONTRACT-01:** receipt commits while inventory/readiness synchronization may fail non-blockingly (`app/actions/procurement.ts`). This can produce incorrect availability and purchase decisions.
- **P0-CONTRACT-02:** order may commit without line items/BOM/finance initialization (`app/actions/orders.ts`).
- **P1-CONTRACT-03:** shipment/QC release enforcement is distributed and lacks one invariant test.
- **P1-CONTRACT-04:** Finance `isRequestProcessed()` is process-memory only. It cannot guarantee global idempotency across serverless cold starts; persistent integration event tables must be the authoritative dedupe boundary.
- **P1-CONTRACT-05:** some projections/milestone links are intentionally non-blocking but lack an owned repair queue.
