# QIMO OS KPI Definition Register

| KPI | Current source/definition evidence | Inclusion/exclusion | Risk |
|---|---|---|---|
| Milestone completion rate | done milestones / total milestones in CEO/analytics queries | legacy done aliases included variably | V1/V2 order templates have different node counts; raw rate is not comparable |
| On-time rate | completed/overdue milestone dates | active/done helpers differ across pages | timezone and approved-delay override definitions vary |
| Overdue order count | distinct orders with active due milestone before now | cancelled/archived/retrospected exclusions vary | dashboard and analytics may disagree |
| Delivery confidence | `runtime_orders` projection from Order/milestone/delay/financial inputs | active operational orders | projection can be stale due to fire-and-forget hooks |
| Factory load/performance | Order quantity + factory completion milestone | lifecycle filters | set vs physical-piece quantity may inflate capacity |
| Procurement readiness/shortage | BOM/MRP/receipt/inventory projections | approved snapshot/active plan expected | receipt-to-inventory failure can make KPI wrong |
| Revenue/order amount | Order/Finance approved values | currencies/order lifecycle | aggregation must not mix currency or set/piece basis |
| Gross margin/profit | finance/baseline/cost snapshot | terminal order filters | duplicated Order vs Finance snapshot age/currency conversion |
| Employee efficiency | milestone completion/overdue by owner role/user | template and reassignment history | ownership transfer can attribute work incorrectly |
| “Prevented loss” | analytics UI multiplies overdue count by fixed average loss | heuristic | not accounting truth; must be labeled estimate |

## Required governance

- Publish canonical status sets, business timezone, quantity basis and currency treatment per KPI.
- Version KPIs when milestone templates change.
- Show `computed_at`, source snapshot/version and data-quality exclusions.
- Never present heuristic “prevented loss” as realized financial value.
- Reconcile CEO, module and Finance dashboards against shared test fixtures.
