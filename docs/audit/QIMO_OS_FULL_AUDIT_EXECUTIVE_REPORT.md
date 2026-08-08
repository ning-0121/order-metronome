# QIMO OS Full-System Audit — Kickoff Executive Summary

Date: 2026-07-19

This is the kickoff-stage audit summary. It is intentionally limited to evidence already collected from the current repository and read-only Production checks. It is not the final audit report.

## 1. Current release truth

- `origin/main`: `ac5d855eed7865f929ead11c4ad8c2d6e2889617`
- Production SHA: `38b5d4d98196f9202abf409c75ab7890068bbc2a`
- Production and `origin/main` are not aligned.
- Production unauthenticated health checks currently respond without 5xx on:
  - `/login` → `200`
  - `/orders` → `307` redirect to `/login`
  - `/production` → `307` redirect to `/login`
  - `/analytics` → `307` redirect to `/login`
  - `/sales-targets` → `307` redirect to `/login`

## 2. Baseline inventory

- Page routes: `71`
- Layout routes: `2`
- Route handlers: `57`
- Server action files: `122`
- Component files: `146`
- Migration files: `209`
- `alert()` call sites found across `app/`, `components/`, and `lib/`: `217`
- Open PRs visible via GitHub CLI at the time of this kickoff: `7`

Top-level page route density:

| Top-level route group | Count |
| --- | ---: |
| `admin` | 15 |
| `procurement` | 11 |
| `orders` | 6 |
| `production` | 6 |
| `analytics` | 5 |
| `quoter` | 4 |
| everything else | 24 |

## 3. Early evidence-based risks

### P0 / blocking evidence

1. Release truth mismatch between `origin/main` and Production.

### P1 / high-risk evidence

1. Analytics page loads all orders and aggregates `quantity` directly at render time.

   Evidence: `app/analytics/page.tsx`

   - `const { data: allOrders } = await (supabase.from('orders') as any).select('id, customer_name, factory_name, quantity, created_at');`
   - `const totalQuantity = (allOrders || []).reduce((s: number, o: any) => s + (o.quantity || 0), 0);`

2. Orders page pulls the full order set before filtering and sorting.

   Evidence: `app/orders/page.tsx`

   - `const { data: allOrders, error } = await getOrders();`
   - the page then performs purpose grouping, completion filtering, search filtering, and sort in memory.

3. Role mapping contains a fallback that can silently degrade unknown roles.

   Evidence: `lib/domain/roles.ts`

   - `normalizeRoleToDb()` defaults unknown values to `'sales'`
   - `ROLE_FALLBACK` maps `qc` to `quality` and `logistics` to `admin`

4. Order creation still mixes commercial quantity and display unit logic.

   Evidence: `app/actions/orders.ts`

   - `const quantityUnit = formData.get('quantity_unit') as string || '件';`
   - `const setMultiplier = quantityUnit === '套' ? 2 : quantityUnit === '三件套' ? 3 : 1;`
  - `const quantity = rawQty ? rawQty * setMultiplier : rawQty;`

5. Sales target and finance-reporting surfaces use quantity-bearing order reads that are not yet harmonized with the analytics page.

   Evidence:

   - `app/actions/sales-targets.ts:80-167`
   - `app/sales-targets/page.tsx`
   - `app/ceo/page.tsx:43-47, 74-88, 144-185, 499-546`
   - `app/api/contract/v1/finance/order-snapshot/[id]/route.ts`
   - `lib/services/profit.service.ts`

   Observed pattern:

   - sales-targets aggregates `orders.quantity` directly inside a lunar-year range query
   - CEO war-room reuses `getAnalyticsSummary()` and also reads `orders.quantity`/milestones for dashboard-wide KPIs
   - finance snapshot exposes `orders.quantity`, `order_line_items.qty_pcs`, and quote-side unit economics in a single read model
   - profit snapshot uses `order.quantity` together with `sale_price_per_piece` and `baseline.cmt_factory_quote`

6. Dashboard / CEO war-room pages are still heavy, wide-scope summaries rather than thin entry portals.

   Evidence:

   - `app/dashboard/page.tsx:140-220`
   - `app/ceo/page.tsx:43-47, 74-88, 144-185, 499-546`

   Observed pattern:

   - both pages load multiple large sets of milestones and orders in a single render
   - dashboard applies role-scoped filters after wide reads
   - CEO page reuses analytics, approvals, customer matters, and milestone rollups in one page

## 4. Audit agent status

Active agents:

- `/root/audit_finance_system`
- `/root/audit_management_dashboard`
- `/root/audit_route_button_inventory`

The audit is still in progress. The first-stage summary is intentionally partial and evidence-led.

## 5. Initial conclusion

- The system is not yet proven stable for all employee workflows.
- There are confirmed data-truth and release-truth risks that require deeper inventory and module-level verification.
- The audit is proceeding in read-only mode.
