# Production Center dashboard execution trace

## Previous execution path

Route `/production` called `requireProductionPage()`, then `getProductionCenter()`. The action loaded the authenticated profile, scope IDs for restricted users, every active order in scope, procurement lines, relevant milestones, manufacturing-order existence, pending delays, and follow-up names. It derived a `ProductionOrderRow` for every active order and returned the complete array to the page.

The page immediately passed the full array to `RoleTaskWorkbench`, `ProductionCenterClient`, and the Gantt chart. `RoleTaskWorkbench` flattened every order through `classifyProductionTasks()`. A supervisor risk order deliberately produced both `异常待处理` and `已超期`; the old presentation used `order_id + task.key`, so the same order appeared as two large cards. The workbench rendered up to 24 large cards, while `ProductionCenterClient` defaulted its full order table to open and rendered every returned order row. With 245 active rows/tasks, the initial RSC payload and client DOM therefore carried the operational list instead of a summary.

The old database path used roughly 7–10 queries depending on role scope and follow-up names. It avoided N+1 for production rows, but selected and serialized all rows. Desktop used responsive grids; the wide detailed table required horizontal scrolling on smaller screens. Embedded scheduling, factory, and progress workspaces were collapsed, but competed with the fully expanded task/table content above them.

## New command-center path

The server still derives stage truth from the existing authorized order/procurement/milestone sources, then projects only summary counts and top command-panel groups into the homepage client payload. No complete order array is passed to the dashboard client. Detailed tasks are collapsed by default and fetched through the authorized `getProductionDetailedTasks()` action only after explicit expansion, search, KPI/stage navigation, or `查看全部`. Results are paginated at 25 rows, capped at 50 per request.

Homepage order is fixed: compact header and search, four quick entries, six KPI cards, operational stage overview, three top-five command panels, then collapsed detail and optional workspaces. Scheduling, factory load, and progress components mount from their actual query-string/anchor destinations.

## Aggregation and authorization

Detailed tasks use `order_id + primary queue scope`. The two risk keys `exception` and `overdue` normalize to one `risk` scope, producing one order row with both badges and reasons. Other genuinely different actions remain separate.

Role projections reuse existing workbench rules. Supervisors receive assignment/factory/delay/risk emphasis and delay approval awareness; follow-up and QC receive their existing execution queues. Approval summaries are omitted for roles that cannot act. All detail reads re-run server authentication and production-scope authorization; UI hiding is not the security boundary.

## Navigation contracts

- 排单与派单工作台 → `/production?workspace=scheduling#scheduling`
- 工厂排产看板 → `/production?workspace=factory#factory`
- 生产进度录入 → `/production?workspace=progress#progress`
- 风险订单攻克 → `/production?detail=已超期#details`

These are existing production components/routes; no fake destination or database migration was added.
