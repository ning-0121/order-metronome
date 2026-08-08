# QIMO OS Route / Button Inventory — Stage 1 Snapshot

Date: 2026-07-19

This is a kickoff snapshot. It is not the final button-level audit matrix.

## Route surface

- Page routes: 71
- Layout routes: 2
- Route handlers: 57

## Highest-priority interactive routes

| Route | Current role/usage | Audit priority |
|---|---|---:|
| `/login` | auth entry | P0 |
| `/orders` | core order workbench / dashboard shell | P0 |
| `/production` | core production center / command shell | P0 |
| `/procurement` | procurement center | P0 |
| `/analytics` | management analytics | P1 |
| `/sales-targets` | management KPI / target comparison | P1 |
| `/my-today` | personal work queue | P1 |
| `/pending-approval` | approvals / decision queue | P1 |
| `/customer-po` | PO / attachment / version workflows | P1 |
| `/risk-orders` | risk intervention | P1 |

## Known button / action samples with current classification

| Route | Button / action | Current status | Evidence |
|---|---|---|---|
| `/analytics` | `查看进度` → `/sales-targets` | PASS | `app/analytics/page.tsx:145-149` |
| `/dashboard` | portal jump to `/orders` | PASS | `app/dashboard/page.tsx:430-507` |
| `/dashboard` | `新建订单` | PASS | `app/dashboard/page.tsx:452-455` |
| `/dashboard` | milestone drilldown to `/orders/{id}?tab=progress#milestone-{id}` | PASS | `app/dashboard/page.tsx:637-749` |
| `/procurement` | `待采购工作台` | PASS | `app/procurement/page.tsx:89-91` |
| `/procurement` | `去录 BOM / 跑 MRP →` | PASS | `app/procurement/page.tsx:112-115` |
| `/procurement` | `收货对账单` / `采购单档案` / `手动建单` | PARTIAL | `app/procurement/page.tsx:77-88` |
| `/production` | `设置 / 初始化` | PASS | `app/production/page.tsx:35` |
| `/production` | `刷新` | PASS | `app/production/page.tsx:36` |
| `/production` | `导出` / reconcile export | PASS | `app/production/page.tsx:36` |
| `/orders` | `新建订单` | PASS | `app/orders/page.tsx:323-331, 538-543` |
| `/orders` | order card / list row to `/orders/{id}` | PASS | `app/orders/page.tsx:564-595, 782-790` |
| `/ceo` | pending approvals jump to `/admin/pending-approvals` | PASS | `app/ceo/page.tsx:646-678` |
| `/ceo` | order drilldown links | PASS | `app/ceo/page.tsx:821-1030` |

Note: this is still a Stage 1 snapshot. It identifies high-value samples only; the final inventory will expand to the full route/button matrix.

## Button and action inventory approach

The final matrix will trace each button from:

`UI -> handler -> action/API -> database/storage -> result -> revalidation -> final UI state`

Initial audit concerns:

1. Buttons that rely on `alert()` instead of an in-app state/result.
2. Download/upload buttons that may not show loading or failure recovery.
3. High-volume list actions that may be duplicated across page and drawer.
4. Role-dependent actions that need server-side enforcement verification.

## Known high-risk interaction clusters

### Production

- download task sheet
- upload tech confirmation / attachments
- scheduling / dispatch actions
- collapsed vs expanded task lists

### Orders

- create / edit
- PO upload / versioning
- order status transitions
- risk / approval / assignment controls

### Procurement

- BOM / accessory import
- budget price persistence
- supplier / line-item updates

### Analytics / management

- summary cards that derive from broad queries
- target / actual reconciliation
- click-through to detail views

## Status

The per-button PASS/BROKEN/PARTIAL matrix is still being compiled from code evidence and runtime sampling.
