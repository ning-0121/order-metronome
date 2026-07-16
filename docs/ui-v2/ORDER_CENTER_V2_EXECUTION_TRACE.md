# Order Center V2 Execution Trace

Date: 2026-07-16
Branch context: `feat/order-center-qimo-v2`
Source of truth: current `origin/main` after PR #29 and PR #30 merges

## 1. Current route map

| Route | Current role | Current purpose | Notes |
| --- | --- | --- | --- |
| `/orders` | Primary order list / workbench hybrid | Search, filter, inspect and drill into orders | Table-first page; fetches all orders up front via `getOrders()` and filters/sorts in-memory |
| `/orders/new` | Order intake entry | Create order from PO / legacy intake mode selector | Server-gated by role; still a form/workflow page, not a dashboard shell |
| `/orders/[id]` | Order detail workspace | Manage one order end-to-end | Dense multi-tab detail page with many action panels, approvals, and operational tools |
| `/orders/from-araos` | ARAOS handoff bridge | Import confirmed PO / ARAOS-originated order data | Bridge surface, not part of the core execution-chain dashboard |
| `/orders/progress-calibrate` | Production manager utility | Batch repair / calibrate progress history | Special utility route for production manager/admin only |
| `/risk-orders/[type]` | Risk list workbench | Filtered risk-order queue (`red`, `yellow`, `green`, `blocked`, `overdue`, `pending`) | Admin-only risk deep-dive route; currently a full list, not a compact dashboard summary |
| `/my-today` | Personal daily task page | Personal task queue + approvals entry | Contains daily tasks and a bottom quick-entry block; useful as a related queue, but not a canonical Order Center dashboard |
| `/admin/pending-approvals` | Approval hub | Aggregated approval queue | Cross-module approval center; useful as a linked queue, not the module-center shell |

## 2. Current information architecture

### `/orders`

Current structure:

1. page title / top controls
2. order purpose tabs
3. status tabs
4. sort controls
5. dimension filters
6. search bar
7. order summary / action block
8. either mobile cards or desktop table

Observed behavior:

- The page is table-first, not dashboard-first.
- It loads all orders through `getOrders()` and then performs client/server-side filtering and sorting in the page.
- The list and the summary are tightly coupled, so the page doubles as overview and workbench.
- It still exposes many direct actions in-page, which makes the page long and dense.

### `/orders/[id]`

Current structure:

1. back button / top banner
2. risk / reschedule banners
3. summary strip
4. many tabs:
   - basic
   - progress
   - delays
   - logs
   - product_link
   - bom
   - manufacturing_order
   - pi
   - procurement_items
   - procurement
   - supply_chain
   - production
   - shipment
   - documents
   - email_center
   - notes
   - score
   - retrospective
5. numerous inline panels and actions

Observed behavior:

- This is a valid detail workspace, but it is dense and contains many operational tools.
- The detail page already has the right “one object” shape; the improvement target is sticky summary clarity and progressive disclosure, not a lifecycle rewrite.

### `/my-today`

Current structure:

1. greeting / daily quote
2. today summary cards
3. approvals entry card
4. task list
5. bottom quick-entry grid

Observed behavior:

- It is useful as a personal task queue, but it is not a canonical module-center dashboard.
- It still uses a bottom shortcut pattern that conflicts with the new dashboard-first architecture.

### `/risk-orders/[type]`

Current structure:

1. risk-type header
2. admin ghost-mode toggle
3. count summary
4. `RiskOrderList`

Observed behavior:

- This is a full list/workbench surface.
- It is good as a deep link from dashboard risk cards, not as the dashboard itself.

## 3. Current data sources and load pattern

### `/orders`

Current data path:

- page component calls `getOrders()`
- page performs purpose filtering, completion grouping, ship-hold filtering, search, and sorting
- summary dimensions are derived from the fetched order array
- desktop table and mobile card list are rendered from the filtered array

Implications:

- The initial render depends on a broad order payload rather than summary-only queries.
- The page is doing both dashboard and workbench jobs at once.

### `/orders/[id]`

Current data path:

- `getOrder(id)`
- `getMilestonesByOrder(id)`
- `getDelayRequestsByOrder(id)`
- `getOrderLogs(id)`
- `order_attachments`
- owner profile lookup
- commissions
- budget approval lookup

Implications:

- Multiple independent queries are correct for a detail workspace.
- The page is feature-rich and should remain a detail workspace, but the summary above the fold needs to stay compact.

### `/risk-orders/[type]`

Current data path:

- `orders` table loaded
- per-order milestone lookup
- risk filter and enrichment performed in page

Implications:

- This is a list-heavy utility page.
- It should stay as a workbench route, not move into the module-center shell.

## 4. Current pain points

1. `/orders` is still a table-first hybrid and does not read like a dashboard.
2. The page loads the full order set before filtering, which is heavier than a summary-only module center.
3. The workbench and dashboard responsibilities are mixed in the same screen.
4. `/orders/[id]` contains many operational tools and can bury the current owner / next action / risk state.
5. `/my-today` still uses a bottom quick-entry block instead of the new top-entry structure.
6. Risk deep-dive exists, but the risk summary still needs to be surfaced from a compact dashboard shell.
7. Quick entry destinations are real, but they are distributed across multiple existing routes instead of one canonical module center.

## 5. Quick-entry routes that are real today

| Quick entry label | Real route | Notes |
| --- | --- | --- |
| 新建订单 | `/orders/new` | Canonical intake entry |
| 订单执行工作台 | `/orders` | Existing operational workbench / list hybrid |
| 风险订单 | `/risk-orders/[type]` | Real route family; choose `red`, `yellow`, `blocked`, or `overdue` depending on the card |
| 待补资料 | No dedicated `/orders/*` route exists today | Closest existing surfaces are `/my-today` and the order detail banners / missing-info tasks; this needs a presentation-only adapter or a dedicated filtered route in the migration |

## 6. KPI / status truth already in use

The Order Center should reuse existing status truth, not invent new lifecycle values.

Relevant existing predicates and groupings:

- `computeOrderStatus(milestones)` for overall risk coloring
- `isActiveStatus`, `isBlockedStatus`, `isDoneStatus`
- lifecycle completion grouping on `completed` / `cancelled` / `已完成` / `已取消`
- risk-order families: `red`, `yellow`, `green`, `blocked`, `overdue`, `pending`

Likely module-center KPI candidates based on current truth:

- 待确认 PO
- 待建单
- 执行中
- 待出货
- 已逾期
- 风险订单

These should be treated as presentation summaries over existing data, not new database truth.

## 7. Role-specific behavior that must remain

- Sales / merchandiser / order manager / admin can enter `/orders/new`.
- Procurement-only users are redirected away from `/orders/[id]` to procurement verification.
- Admin-only risk deep-dive remains on `/risk-orders/[type]`.
- Production manager-only calibration remains on `/orders/progress-calibrate`.
- Server-side role gating must remain the enforcement point.

## 8. Functions that must not move or change

Keep untouched during the Order Center UI migration:

- `createOrder`
- PO parsing
- customer selection
- order lifecycle
- approval routing
- RBAC / capability checks
- Server Action contracts
- downstream BOM / procurement / production initialization
- idempotency
- audit logs
- financial truth

## 9. Recommended first migration slice

The safest first step is a presentation-only module-center shell on top of existing truth:

1. compact header
2. compact quick-entry row
3. KPI summary from existing order state
4. execution stage overview from existing milestone predicates
5. today tasks / approvals / risks with top-five summary queries
6. collapsed detailed order list, loading lazily or linking to the workbench

This should be implemented with summary adapters only; no schema change and no lifecycle change.
