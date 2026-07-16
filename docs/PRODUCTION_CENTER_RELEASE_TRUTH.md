# Production Center release truth

Verified 2026-07-16 against GitHub, `origin/main`, Vercel Production, and both route implementations.

## Deployment truth

- `origin/main`: `e0b2de8e32da60438481b3ab9ba1581d34ce11cb` (PR #27 create-order customer-state hotfix).
- Production deployment: `dpl_cQpKzCTZop8hHja6sNGdBpE5o3XG`, READY, custom domain `order.qimoactivewear.com`.
- Deployed Git SHA: `e0b2de8e32da60438481b3ab9ba1581d34ce11cb`, exactly equal to `origin/main`.
- PR #28 is OPEN, CLEAN and MERGEABLE. It has no merge commit. Its HEAD is `45117c007cd0dbaa4254bfee59c95721ed34953f`.
- PR #28 commits `cf78b28`, `3572490`, `6f68f58`, and `45117c0` are not ancestors of `origin/main` (`git merge-base --is-ancestor` returned false).
- No later merge reverted PR #28: it was never merged. No Production deployment contains its HEAD.

Therefore Production did not fail to update and is not serving a stale deployment. The approved redesign exists only on PR #28 and its Preview. Documentation/design-foundation work is unrelated to whether `/production` changed.

## Current Production route trace

There is one application route: `/production` → `app/production/page.tsx`. There is no role-specific alternate route and no dashboard feature flag.

On `origin/main`, the page calls `requireProductionPage()`, `getProductionCenter()`, derives `workbenchRole`, then renders:

1. `RoleTaskWorkbench rows={rows}`
2. `ProductionCenterClient rows={rows}`
3. optional collapsed Gantt/scheduling/factory/progress sections

`components/production/RoleTaskWorkbench.tsx` sets the supervisor heading to `生产主管今日任务`, computes all classified tasks, prints the total count, and renders a three-column grid (`md:grid-cols-2 xl:grid-cols-3`). It renders up to 24 large task cards. The legacy `ProductionCenterClient` defaults its full order table open, which accounts for the remaining long list of active rows.

For a supervisor risk order, `classifyProductionTasks()` emits both `exception / 异常待处理` and `overdue / 已超期`. The legacy workbench keys them separately, so one order can appear twice. All active production rows are loaded server-side and passed into both legacy components.

## PR #28 implementation trace

PR #28 removes `RoleTaskWorkbench` from `app/production/page.tsx` for every permitted role. The page renders the same command-dashboard component for manager, follow-up, and QC, while passing a role-derived summary projection.

The command dashboard order is fixed:

1. compact header/search/refresh
2. four quick entries
3. six KPI cards
4. six-stage progress overview
5. three command panels (maximum five rows each)
6. `生产主管详细任务` collapsed by default

The initial client payload contains summary counts and compact grouped command rows, not the full active-order array. No detailed task row is rendered initially. `getProductionDetailedTasks()` runs only after explicit expand, search, KPI/stage navigation, or `查看全部`, rechecks authentication/scope, and returns at most 25 consolidated compact rows per request (server cap 50).

Risk aggregation normalizes the same order's `exception` and `overdue` tasks to `order_id:risk`, preserving both badges/reasons in one row. Genuinely different action scopes remain separate.

## Performance evidence and limits

Before PR #28:

- initial source derivation: all active orders plus their batch procurement/milestone/MO/delay data
- initial client data: complete `ProductionOrderRow[]`
- task DOM: up to 24 large cards plus the complete default-open order table (245 rows in the CEO evidence)
- duplicate risk presentation: possible

After PR #28:

- initial source derivation: the same batch truth is required to compute stages and role summaries; one count query adds completed/archived scope
- initial client data: summary object plus at most 15 command rows; no complete order array
- detailed task DOM: zero by default; 25 compact rows per explicit load
- duplicate risk presentation: consolidated by order and action-owner scope

There is no persisted “production task” table to count directly: workbench tasks are deterministic projections of orders and milestones. PR #28 prevents their full projection from being serialized/rendered initially. A future database summary RPC may reduce source rows scanned, but is not required to remove the 245-card/table UX and would require separate database-change approval.

## Release conclusion

PR #28 is the focused implementation that visibly changes `/production`; it is not a design-document-only PR. Production will remain legacy until CEO explicitly approves merging PR #28 and the resulting GitHub-triggered Vercel Production deployment is READY.
