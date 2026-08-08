# QIMO OS Issue Register — Stage 1 Draft

Date: 2026-07-19

This register is a draft based on read-only evidence gathered during audit kickoff.

## Confirmed / high-confidence items

| Issue ID | Module | Severity | Evidence | Current risk |
|---|---|---:|---|---|
| R1 | Development / release | P0 | `origin/main` ≠ Production SHA | Production truth is not aligned with the repo tip |
| A1 | Analytics | P1 | `app/analytics/page.tsx:13-42` | Dashboard load depends on broad order read + page-level aggregation |
| O1 | Orders | P1 | `app/actions/orders.ts:1070-1106` | Operational list path is broad and needs volume / paging / scoping verification |
| P1 | Roles | P1 | `lib/domain/roles.ts:14-19, 33-60, 78-115, 140-200` | Fallback mapping can mask invalid or unmapped roles |
| S1 | Sales targets | P1 | `app/actions/sales-targets.ts:80-167`, `app/sales-targets/page.tsx:17-170` | Annual target progress uses `orders.quantity` directly with narrower lifecycle filtering than analytics |
| D1 | Dashboard | P1 | `app/dashboard/page.tsx:140-220` | Portal page pulls multiple large milestone/order sets and heavy role-scoped queues in one render |

## Existing issue-program buckets still open

- P0: production task download, attachment upload, size chart recognition
- P1: quantity/unit semantics, PO replacement, delay logic, production dispatch, board truth, analytics metric consistency
- P2/P3: UI consistency and feedback debt

## Notes

- No production data was modified.
- No code was changed for this register.
- Findings below this line remain under review until they are backed by route/button/runtime evidence.
