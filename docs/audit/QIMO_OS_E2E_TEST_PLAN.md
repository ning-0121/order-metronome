# QIMO OS E2E Test Plan

Synthetic fixture: `TEST-QIMO-E2E-001`; it contains no real person, customer, order or financial data. Preview and Production share a database, so the automated suite is pure/mocked and performs no Supabase writes.

| Suite | Invariants | Current automation |
|---|---|---|
| A Happy Path | SKU/order/shipment/payment totals reconcile | pure fixture assertions |
| B AI Failure / Manual Entry | manual work remains; AI cannot write Finance | Runtime tool gate; UI integration still required |
| C Set Product | set/component basis, precision, loss once | decimal/requirement tests |
| D Material Shortage | raw precision, inventory, unit mismatch | consumption unit tests; inventory integration pending |
| E Production Delay | chain role, self-approval, next owner | G-K domain tests; DB/RLS integration pending |
| F QC Failure/Reinspection | hold, corrective action, reinspection, release | fixture defined; shipment gate integration pending |
| G Partial Shipment | cumulative SKU quantity <= approved | pure totals; persistence/idempotency pending |
| H Partial Payment | schedule/receipt/overpayment/refund | schedule totals; Finance integration pending |
| I Revision | approved change, downstream stale markers | deterministic parser; cross-module replay pending |
| J Cancellation | no new procurement/shipment/payment; reversal | TEST marker; domain integration pending |
| K Unauthorized Role | server denial despite forged UI/client actor | tool safety; full RBAC matrix pending |
| L Duplicate Retry | stable idempotency and safe attachment key | safe-key uniqueness; persisted event dedupe pending |

The suite intentionally distinguishes calculation/contract proof from live workflow proof. Employee authentication and an isolated test database are prerequisites for a true browser E2E run.
