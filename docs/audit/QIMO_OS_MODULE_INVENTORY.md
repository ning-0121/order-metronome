# QIMO OS Module Inventory — Kickoff Draft

Date: 2026-07-19

This inventory is based on the current repository state and is meant to anchor the full-system audit kickoff.

## Top-level observations

- The repository currently exposes 71 page routes and 57 route handlers.
- The largest visible route groups are `admin`, `procurement`, `orders`, `production`, and `analytics`.
- The system is split across many business modules plus supporting admin and integration surfaces.

## Initial module list

| Module | Evidence |
| --- | --- |
| Development / release | Git, PR, worktree, Vercel / Supabase environment truth |
| Order center | `/orders`, `/api/orders/*`, order actions |
| Production center | `/production`, production actions, stage init, dashboard |
| Procurement center | `/procurement`, procurement actions, supplier/material routes |
| Analytics / management | `/analytics`, `/sales-targets`, `/admin/*` |
| Finance integration | `/api/finance-sso`, `/api/integration/finance-callback`, finance contract routes |
| Customer / PO | `/customer-po`, order detail and attachment flows |
| Technical / sample data | size chart, parser, BOM, production task sheets, file upload/download flows |

## High-priority areas already evidenced

| Area | Current evidence | Risk class |
| --- | --- | --- |
| Analytics totals | Full order scan + direct `quantity` aggregation in `app/analytics/page.tsx` | P1 |
| Order loading | Full order fetch in `app/actions/orders.ts` | P1 |
| Role mapping | Unknown role fallback to `sales` in `lib/domain/roles.ts` | P1 |
| Quantity semantics | Commercial/unit handling is mixed in `app/actions/orders.ts` | P1 / P0 depending on downstream effect |

## Inventory status

This file is a kickoff draft. Full route/button, role, lineage, and workflow matrices are still being produced by the audit agents.

