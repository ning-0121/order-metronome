# QIMO OS V2 Migration Plan

This plan keeps the rollout small and reversible.

## Phase 0

Scope:

- inventory;
- audit;
- design tokens;
- shared primitives;
- no page replacement.

Dependencies:

- current route map;
- current role model;
- current business actions.

Feature flags:

- none required for documentation-only work.

Rollback:

- delete or disable new primitives without touching pages.

Success metrics:

- canonical page structure documented;
- shared foundation components available;
- no business logic changes.

## Phase 1

Scope:

- Production Center is the current reference implementation;
- consolidate shared tokens and primitives around the existing direction;
- no second Production Center dashboard implementation;
- no APS specialization in this foundation branch.

Dependencies:

- `QimoPageHeader`;
- `QimoQuickEntry`;
- `QimoKpiGrid`;
- `QimoCommandGrid`;
- `QimoCollapsibleSection`.

Feature flags:

- page-level render switch only if needed.

Employee acceptance:

- shared primitives are reusable;
- no duplicate component families exist;
- current Production Center implementation remains the source of truth.

Rollback:

- remove the foundation primitives without touching the Production Center shell.

## Phase 2

Scope:

- Order Center shell migration.

This is the first module-center rollout after the foundation branch is approved.

## Phase 3

Scope:

- Procurement Center shell migration.

## Phase 4

Scope:

- Logistics Center shell migration.

## Phase 5

Scope:

- System Portal canonical entry.

## Phase 6

Scope:

- high-frequency workbenches;
- tables, filters, saved views;
- compact rows.

## Phase 7

Scope:

- detail workspaces;
- sticky summary;
- contextual actions.

## Phase 8

Scope:

- forms;
- approvals;
- dialogs;
- AI recommendation standard.

## Migration Rules

- Never mix shell migration with workflow state changes.
- Never change RBAC during UI rollout.
- Never rewrite business-heavy components for styling alone.
- Prefer replacing page wrappers before deep component surgery.
- Keep each Center in its own branch and PR.
