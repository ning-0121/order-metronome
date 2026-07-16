# QIMO OS V2 UI Audit Report

Audit date: 2026-07-16

Scope: `Production Center`, `Order Center`, `Procurement Center`, `Logistics Center`, `System Portal`

Repository snapshot: 68 route pages, 143 components, 219 `alert()` call sites across `app/`, `components/`, `lib/`

## 1. Audit Summary

Current release truth:

- PR #28 is merged into `main` and deployed;
- PR #29 is open and is the current Production Center finalization branch;
- the Production Center shell is already the first QIMO V2 reference implementation;
- the shared foundation work in this run must reuse that direction, not create a competing one.

The current UI still reads like a traditional ERP in several places:

- dashboards often open into tables or long task lists instead of a decision-first overview;
- the same workflow can appear in both a homepage block and a deeper workbench block;
- error handling is still heavily `alert()` driven;
- role-specific surfaces are mixed with generic operational lists;
- the system portal is distributed across multiple entry pages rather than one canonical hub.

The largest remaining violations are now outside the Production Center shell: Order Center, Procurement Center, Logistics Center, System Portal fragmentation, and several high-frequency workbenches/forms/details.

Production Center should now be treated as the reference implementation for the module-center archetype, while its remaining specialization work moves into APS-style follow-on work.

## 2. System-Level Findings

### What belongs in the System Portal

- company overview;
- personal mission;
- approvals;
- risks;
- notifications;
- cross-system entry;
- external system handoff cards for ARAOS and Finance OS only.

### What belongs in the core execution chain

- Order Center;
- Procurement Center;
- Production Center;
- Logistics Center.

### Current reality

- `/hub` is the closest thing to a portal, but it is only a card grid of systems.
- `/dashboard` is a personal execution workbench, not a system portal.
- `/ceo` is an executive control room with many dense analytics/risk blocks.
- `/my-today` is a personal daily task page with bottom shortcuts.
- `/` is a redirector, not a portal.

## 3. Release Truth Matrix

| Area | Current main implementation | Open PR implementation | Deployment state | Recommended next work |
|---|---|---|---|---|
| Production Center | PR #28 command dashboard on `main` | PR #29 final cleanup and APS workbench routes | Production deployed | Keep shell stable, move next work to APS-only specialization |
| Order Center | Existing order list/detail/form surfaces on `main` | No current V2 shell PR | Production unchanged | Start V2 module-center rollout here |
| Procurement Center | Existing procurement workbench/list surfaces on `main` | No current V2 shell PR | Production unchanged | Rework shell to dashboard-first layout |
| Logistics Center | Existing logistics queue/list surface on `main` | No current V2 shell PR | Production unchanged | Rework shell to dashboard-first layout |
| System Portal | Split across `/hub`, `/dashboard`, `/ceo`, `/my-today` | No canonical portal PR | Fragmented | Consolidate portal entry and external-system placement |

## 3. Current Page Inventory

| Route | Module | Category | Primary roles | Primary task | Current layout | Main actions | Data source | Page length | Density | Duplicate information | Usability / performance risk | V2 disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/hub` | System Portal | Portal entry | all logged-in roles | enter a system | 3-column system cards | open system / external handoff | OS registry + profile | short | medium | no | not a mission dashboard; lacks approvals / risks / today priorities | replace |
| `/dashboard` | My Workbench | Personal execution workbench | sales / merch / finance / production / qc / logistics / admin | today task triage | tall single-page dashboard with many blocks | approvals, overdue, due today, risks, retrospectives | `orders`, `milestones`, `delay_requests`, `profiles` | very long | high | yes | fetches multiple full lists; mixes decision blocks with detailed task lists | split |
| `/ceo` | Executive command room | Executive dashboard | admin | global control | many stacked KPI, risk, approval, trend blocks | approvals, risk review, insights | `orders`, `milestones`, `delay_requests`, `customer_matters`, approvals | very long | high | yes | dense page, many full lists, several sections render many items immediately | simplify |
| `/my-today` | Personal day view | Daily work list | all roles | my tasks | compact header + KPI + task list + bottom shortcuts | task list, approvals link, shortcuts | `daily_tasks`, `pending_approvals` | medium | medium | no | still task-list first; bottom shortcuts are not the main architecture | simplify |
| `/orders` | Order Center | Operational list / dashboard hybrid | order, merch, sales, admin | search and inspect orders | filter row + phase cards + long table | filter, search, stage drill-down | `orders`, `milestones`, delay data | very long | high | yes | table-first; phase cards and table repeat the same information; too much information at once | simplify |
| `/orders/[id]` | Order Detail | Detail workspace | order, merch, sales, admin | manage one order | tabs + dense summary + attachments + history | edit, approve, upload, recalc | `orders`, `milestones`, attachments, approvals | very long | high | yes | detail page carries many business tools; acceptable as detail but needs stronger sticky summary and progressive disclosure | keep / simplify |
| `/orders/new` | Order Intake | Form | sales / merch / admin | create order | large multi-section form | parse PO, select customer, submit | order form state + PO parser | long | high | yes | complex form, alert-driven validation, stale-state risk | simplify |
| `/orders/from-araos` | ARAOS handoff | Intake bridge | sales / admin | import confirmed PO | import list + builder | build order from PO | ARAOS-backed order data | medium | medium | no | bridge page is functional but not integrated into system portal | keep |
| `/procurement` | Procurement Center | Workbench + risk center | procurement / manager / finance / admin | queue handling | top nav buttons + queue client + risk center | queue processing, ledger / receipt / PO shortcuts | procurement queues + material matters | long | high | yes | still queue-first and list-heavy; top actions are numerous and visually noisy | simplify |
| `/procurement/po` | Procurement list | Workbench | procurement / finance / admin | browse purchase orders | table/archive page | search, inspect, export | procurement PO data | long | high | yes | table-heavy archive page, no Dashboard layer | keep / simplify |
| `/procurement/po/new` | PO form | Form | procurement | create purchase order | form + table lines | create, search supplier | supplier and line data | medium | medium | no | acceptable as detail form, but still uses alert-heavy validation patterns | keep / simplify |
| `/procurement/ledger` | Supplier ledger | Workbench | procurement / finance / admin | supplier reconciliation | grouped batches + tables | import, reconcile, push payable | supplier ledger import | long | high | yes | finance-like table density with many nested rows | split |
| `/procurement/inventory` | Inventory workbench | Workbench | procurement / admin | stock review | cards + tables | adjust, view details | inventory balance data | long | high | yes | mixed summary and detail table; lacks canonical command-center tier | simplify |
| `/production` | Production Center | Module center / command dashboard | production / qc / manager / admin | supervise production flow | compact header + quick entries + KPI cards + stage overview + three compact panels + collapsed detailed tasks | filter, assign, export, progress, schedule | `production_center`, scheduling, progress boards | medium | medium | no | first V2 reference implementation; remaining complexity is in APS / factory-schedule specialization | keep / refine |
| `/production/order/[id]` | Production detail | Detail workspace | production / qc / manager | single-order production handling | dense order detail | update milestones, documents, progress | production order and milestones | long | high | yes | appropriate as detail, but still quite dense | keep / simplify |
| `/production/stage-init` | Stage init utility | Utility form | production_manager / admin | seed production stage | table + quick actions | initialize stages | stage init actions | medium | medium | no | utility page should not be surfaced as a primary center | retire / hide |
| `/production/scheduling` | APS workbench | Specialized workbench | production_manager / admin | factory assignment | task board + dispatch panel | schedule, dispatch | production scheduling actions | medium | medium | no | specialized APS surface, not the module shell | keep |
| `/production/factory-schedule` | APS workbench | Specialized workbench | production_manager / admin | factory load review | factory load board | review, export, drill into dispatches | production scheduling actions | medium | medium | no | specialized APS surface, not the module shell | keep |
| `/production/progress` | Production progress workbench | Specialized workbench | production / qc / manager / admin | progress entry | progress board | log progress, mark done | production scheduling actions | medium | medium | no | specialized workbench, not the homepage shell | keep |
| `/logistics` | Logistics Center | List-first workbench | logistics / production_manager / admin | outbound shipping queue | compact list of shipment cards | open shipment detail | shipment queue data | medium | medium | no | still lacks dashboard-first layers and command panels | simplify |
| `/analytics` | Analytics / reports | Reporting | admin / leadership | metrics review | large KPI cards + charts + calls to action | drilldown, analysis pages | analytics actions | long | high | yes | reporting and operations are mixed on one page; good for analytics, not a center homepage | split |
| `/analytics/*` | Sub-reports | Reporting detail | admin / leadership | deep analysis | charts / tables | drilldown | analytics data | medium | medium | no | acceptable as detail/report layer | keep |
| `/admin/*` | Governance | Administrative tools | admin | system governance | many tool pages | approvals, users, audits | admin service/data | varies | varies | yes | too many mixed-purpose admin tools in one top-level bucket | split |

## 4. Top Usability Failures

- Pages are too long.
- Dashboards are acting like detailed task lists.
- The same order or exception can appear more than once in different blocks.
- The next action is often buried below summary data.
- Critical context is frequently split across cards, tables, and nested panels.
- Buttons and cards use inconsistent visual language.
- Error handling still relies on browser `alert()` in many flows.
- Many pages mix read-only insight with write actions for multiple roles.
- Several screens load far more data than the initial view requires.
- Some forms validate only at submit time and surface generic errors at the bottom.

## 5. Current Design Inconsistency

### Visual language issues

- emoji icons and SVG icons are mixed without a shared system;
- gradients appear in some portals and not others;
- card radius varies between `rounded-lg`, `rounded-xl`, and `rounded-2xl` without a rule;
- shadow intensity varies by page;
- some pages use very light neutral surfaces, others use tinted fills for the entire section;
- status colors are not consistently scoped to the same meaning across modules.

### Interaction issues

- some surfaces are links, some are buttons, some are nested cards with a child button;
- `alert()` is still a primary error path;
- several pages render long lists immediately rather than deferring to workbenches;
- mobile and desktop density rules differ by page.

## 6. Baseline Metrics

- Route pages: 68
- Components: 143
- `alert()` occurrences in app/components/lib: 219
- Pages with obvious initial heavy list rendering: Production, Order Center, Procurement Center, Logistics Center, Dashboard, CEO, Analytics, Procurement ledger, Procurement inventory, Order detail
- Pages lacking explicit pagination/virtualization on primary list surfaces: most list-heavy workbenches
- Pages with obvious role-specific action filtering gaps in the UI layer: CEO, dashboard, production, procurement, order detail

## 7. Shared Component Audit

### Components that can be generalized

- `components/Navbar.tsx` → split into a shell-level `QimoPageHeader` / nav model
- `components/CollapsibleSection.tsx` → `QimoCollapsibleSection`
- `components/TaskCard.tsx` / `components/ExpandableList.tsx` → `QimoCompactTaskRow` + table/list primitives
- `components/DashboardAIAdvice.tsx` / `components/AgentSuggestionCard.tsx` → `QimoAiToday`
- `components/CollabRiskGroups.tsx` / `components/RiskOrderList.tsx` → `QimoRiskCard`
- `components/OrderSearchBar.tsx` → `QimoFilterBar`
- `components/SearchableSelect.tsx` → keep as form primitive, not a page shell primitive

### Components that should stay business-specific

- `components/order/LegacyOrderForm.tsx`
- `components/order/POOrderForm.tsx`
- `components/production/SchedulingBoard.tsx`
- `components/production/FactoryScheduleBoard.tsx`
- `components/production/ProductionProgressBoard.tsx`
- `components/procurement/ProcurementQueueClient.tsx`

These components contain domain rules and should not be abstracted until the underlying page architecture is stable.

## 8. V2 Decision

### Keep

- detail/workbench pages that already represent one object at a time;
- bridge pages that are genuinely handoff-specific;
- reporting sub-pages.

### Simplify

- dashboard surfaces that mix KPI, todo, approvals, risks, and full task lists;
- order and procurement homepages that still mix overview with list-heavy execution;
- logistics center list surfaces;
- admin/analytics mixed dashboards.

### Replace

- System Portal homepage.

### Split

- dashboard / CEO / analytics mixed surfaces;
- procurement ledger and inventory flows;
- analytics overview pages with many report functions;
- Order Center, Procurement Center, and Logistics Center module shells into dashboard / workbench / detail tiers.

### Retire

- one-off utility pages that should not be part of the canonical center navigation.

## 9. First Implementation Direction

1. Canonical layout primitives: header, quick entry, KPI, AI today, approvals, risks, workbench, detail, empty/error/loading.
2. Production Center as the reference implementation and APS specialization boundary.
3. Order Center, Procurement Center, Logistics Center, System Portal as follow-on centers.
4. Existing detailed workbench pages only after the new shell is stable.
