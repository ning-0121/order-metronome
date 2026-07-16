# QIMO OS State-Machine Register

## Responsibility invariants

- Confirmed handoff adds Business Execution ownership; Development retains customer-commercial-change visibility only.
- Factory/schedule confirmation is a Production Manager decision with actor/time/reason.
- Assigning Production Follow-up/QC adds responsibility; it never replaces the order owner.
- Packing/shipment retain Business Execution and Production Follow-up/QC while adding Logistics.
- A customer-impacting production delay requires production approval followed by commercial confirmation.

| Machine | Canonical states evidenced | Owner / transition guard | Side effects | Audit gaps |
|---|---|---|---|---|
| Order lifecycle | draft, active/in_progress, completed, cancelled, archived plus Chinese legacy aliases | order roles/managers; lifecycle guards | milestones, finance sync, notifications | duplicate bilingual status definitions; late initialization is non-atomic |
| PO parsing | uploaded/draft, parsing, parsed/failed; draft freeze semantics | Sales + Runtime schema | recognition draft/snapshot | frozen snapshot overwrite exists in Production main |
| Size chart | UPLOADED, PARSING, PARSED, NEEDS_REVIEW, APPROVED, FAILED, DUPLICATE | authenticated order access/reviewer | parsed payload/manual apply | live employee flow not proven |
| Accessory import | SOURCE_IMPORTED, MATCHED_TO_EXISTING, NEW_ACCESSORY, NEEDS_REVIEW, APPROVED, EXCLUDED | authenticated reviewer/RLS | reviewed BOM candidate only | no full live flow proof; Preview shares Production DB |
| Milestone | pending, in_progress, blocked, done plus legacy Chinese/completed aliases | owner role/user and role groups | logs, next node, runtime projection | template V1/V2 and historical materialized nodes coexist |
| Delay request | pending, approved, rejected; approval-chain `current_step` | current chain role; self-approval denied | schedule/order amendment, notification | manager comments/policy drift; service-role write after guard |
| BOM/package | draft/active/submitted/approved/superseded; plan open/active | BOM roles and approvals | snapshot, MRP, procurement | sync-origin rows can be overwritten; version policy fragmented |
| Procurement | draft/reviewing/confirmed/ordered/partially_received/completed/closed plus approval sub-states | procurement + manager + Finance | PO, receiving, payable integration | many parallel tables/statuses; canonical aggregate state absent |
| Production | intake/assignment/factory/schedule/cutting/online/completion represented by milestones, dispatch and workbench classification | production manager/follow-up | assignment logs, milestones, QC triggers | no single explicit production state machine; derived queues can disagree |
| QC | inspection type/status/reinspection/release in `qc_inspections` and milestones | QC/authorized roles | hold/release/evidence | trigger and shipment-block coverage not centrally proven |
| Shipment | pending, sales_signed, warehouse_signed, fully_signed and batch lifecycle | Sales/logistics/Finance as configured | order/logistics/finance | partial/retry idempotency needs golden test |
| Finance | source-specific approval/settlement/GL queue/freeze/close states in Finance DB | authenticated Finance roles/human approvals | receivable/payable/GL/profit | separate repo has many engines but no single published state register |
| Runtime projection | event append -> projected confidence/version | service role projection | dashboards/alerts | fire-and-forget hooks permit stale state; reconciliation/age must be visible |

## State-machine defects

- **P0-STATE-01:** Order creation reports success after some required line/BOM/finance initialization failures. This creates a valid Order state with incomplete child-state initialization.
- **P1-STATE-02:** English and Chinese lifecycle/status aliases are handled ad hoc across queries, making inclusion/exclusion inconsistent.
- **P1-STATE-03:** Unknown milestone owner roles fall back to Sales instead of rejecting an invalid transition/assignment.
- **P1-STATE-04:** Production and QC lifecycle is distributed across milestones, dispatch, reports and derived workbench queues; no single transition contract proves trigger/owner/evidence.
- **P2-STATE-05:** eventual Runtime projection lacks an employee-visible stale/replay state in audited UI evidence.

## Transition test standard

Every state transition requires: authenticated actor, canonical role, current-state compare-and-set, evidence/precondition check, idempotency key or guarded status, audit row, deterministic next owner and a failure that leaves the previous state intact.
