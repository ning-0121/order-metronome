# QIMO OS Role and Permission Matrix

> CEO correction (2026-07-16): role membership, per-order responsibility and approval authority are independent truths. `merchandiser` is Business Execution and remains overall order owner through shipment/closure. `production_manager` alone finalizes factory and production schedule. `production` is the combined Production Follow-up/QC and remains factory-side owner through shipment. Administrative supervision is visibility/escalation only.

| Decision | Allowed | Explicitly denied |
|---|---|---|
| Special price | sales_manager; explicit audited admin override | execution/production/procurement |
| Customer commitment change | order_manager or sales_manager according to commercial ownership | production acting alone |
| Production delay | production_manager | requester self-approval / production self-approval |
| Final factory and schedule | production_manager; audited admin override | merchandiser, production, logistics |
| QC release | authorized production/QC responsibility | logistics, sales |
| Payment | authenticated Finance workflow | AI, procurement, production, execution |

Canonical application roles are defined in `lib/domain/roles.ts`. `profiles.roles[]` is preferred over legacy `profiles.role`.

| Role | Primary scope | Create/edit | Assign | Approve/reject | Sensitive values | Key restrictions |
|---|---|---|---|---|---|---|
| `sales` | customer/PO/order creation | own customer/order, supplier basics | no global reassignment | PO/customer decisions; not own separation-required request | financials yes | only own/assigned orders; execution nodes are not general Sales actions |
| `sales_manager` | customer commitment/business supervision | business domain | reassignment | price and customer-facing delay | financials yes | cannot replace production operational approver merely by UI visibility |
| `merchandiser` | post-PO order execution | assigned order, MO, BOM | no manager-wide assignment | chain step when explicitly required | no procurement floor | must be related to order; cannot self-approve delay |
| `order_manager` | order execution supervision | BOM/order supervision | reassignment | delay manager authority | financials yes | supervisor, not generic milestone executor |
| `finance` | financial review/payment truth | finance domain/supplier finance | no production assignment | finance/procurement-finance/payment steps | full financials | cannot approve procurement operational truth or AI autonomous write |
| `procurement` | materials and purchase execution | BOM/procurement execution | supplier selection | no finance payment approval | procurement floor | cannot autonomously approve manager/finance gates |
| `procurement_manager` | procurement supervision | procurement execution | procurement scope | procurement approval | procurement floor | cannot approve Finance payment |
| `production` | production follow-up | assigned production actions | factory/task within scope | production chain confirmation | no customer financials | cannot self-approve own delay |
| `production_manager` | production intake/supervision | production workbench | follow-up assignment/reassignment | production operational delay | no customer financials | cannot approve business-only customer commitment |
| `qc` / legacy `quality` | inspection/release evidence | QC records | no generic production reassignment | QC steps/waiver per policy | no financials | cannot change commercial Order truth |
| `logistics` | shipment execution | logistics/shipment | logistics scope | shipment confirmation steps | no financials by default | QC/payment holds must remain server enforced |
| `admin_assistant` | administrative oversight | limited BOM/MO support | no unrestricted admin override | no financial/price override | management visibility in some views | must not inherit `admin` write authority |
| `admin` | audited break-glass | all server-authorized domains | yes | override | yes | override actor/reason must be logged; still no AI self-approval |

## Canonical capability groups

- Financial visibility: admin, finance, sales, sales manager, order manager.
- See all orders: admin, finance, admin assistant, production manager, sales manager, order manager, procurement manager.
- Reassign owner: admin, production manager, sales manager, order manager.
- Procurement approval: admin, procurement manager.
- Procurement financial approval: admin, finance.
- BOM editing: admin, Sales/business managers, merchandiser, admin assistant, procurement roles.
- Business-block override: admin only.

## Verified invariants

- Delay chain checks requester/actor equality; non-admin self-approval is denied.
- G-K routing assigns a production-owned delay to `production_manager`; customer-facing change remains a later business role decision.
- Milestone completion validates authenticated user role/assignment server-side, not only button visibility.
- Sensitive line-item pricing is stripped server-side for roles outside `CAN_SEE_FINANCIALS`.

## Findings

1. **P1-RBAC-01:** `normalizeRoleToDb()` silently maps unknown roles to `sales`. A typo can transfer workflow ownership to Sales instead of failing closed. New writes should reject unknown roles; legacy reads may retain compatibility mapping.
2. **P1-RBAC-02:** Role policy is not fully single-source. Numerous actions still contain local role arrays and aliases despite the file warning that all checks use `ROLE_GROUPS`.
3. **P1-RBAC-03:** Several server actions use service role after local authorization. Correctness depends entirely on every local guard; RLS cannot contain a missed guard.
4. **P2-RBAC-04:** Comments around delay manager override no longer match `canActOnDeferralStep`; stale comments can cause future authorization regressions.
5. **P2-RBAC-05:** No repository-wide automated matrix proves UI visibility equals server authorization for every action.

## Required regression matrix

For every write action test unauthenticated, wrong role, correct role, inactive assignee, self-approval, replay/double submit, admin override audit, and forged client actor ID. UI tests must assert hidden/disabled action from the same server capability output.
