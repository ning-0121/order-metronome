# QIMO PR #31 UAT Fixture Architecture

## Problem statement

PR #31 needs controlled UAT for budget unit price persistence and production task download, but the current Preview and Production environments share the same Supabase project, auth, and storage identities. That makes Preview write UAT unsafe unless the test data is isolated by design.

No safe existing test order was found. The only visible test-labeled order is already connected to live workflow truth and is not suitable as a fixture.

## Selected model

Model A: dedicated fixture registry plus fixture-owned canonical rows.

This means:

- a small registry table owns the fixture lifecycle;
- the fixture owns a minimal set of canonical rows required for the tested contract;
- the live business tables are not repurposed as ordinary orders;
- cleanup is driven by fixture ownership, not by scanning business tables for a flag.

Why this model:

- it exercises the real `saveBomBudgetUnitPrice()` / `listBomConsumptionLines()` persistence path;
- it preserves the current RBAC and RLS model;
- it avoids adding `is_test_fixture = false` filters throughout analytics and workflow queries;
- it supports deterministic cleanup;
- it keeps the long-term “isolated Preview Supabase” target separate.

Rejected for this phase:

- Model B, because marking live business orders and then excluding them broadly would leak fixture semantics into production logic and create a filter burden across analytics, production, procurement, logistics, finance, and notifications.
- Model C, because it is the correct long-term target but requires infrastructure work outside this PR.

## Minimum data graph

Only the following graph is required for the PR #31 budget-unit-price UAT path:

1. authenticated user
2. authorized role
3. `uat_fixtures` registry row
4. fixture-owned synthetic order row
5. fixture-owned `materials_bom` row
6. optional fixture-owned `order_cost_baseline` row for “baseline suggestion” behavior
7. `saveBomBudgetUnitPrice()` write
8. authoritative read-back through `listBomConsumptionLines()`

For the production-task download path, the fixture may additionally own only the minimum order fields required by the export path.
It must not create milestones, procurement execution, finance truth, notifications, or approvals.

## Why the previous Model B recommendation was rejected

Model B was the emergency fallback when no separation existed.

After tracing the write path:

- `materials_bom` already has the canonical write target for budget unit price;
- `materials_bom.order_id` is a real foreign key to `orders`;
- live workflow tables and dashboards consume `orders`, `milestones`, `procurement_line_items`, and `order_cost_baseline` directly;
- a live-order test fixture would either need broad “exclude fixture” filters or must rely on terminal/archived behavior plus strict registry ownership.

For this phase, the registry-owned fixture model is smaller and less invasive than making the live order surface fixture-aware.

## Required schema

Draft only; not applied.

### `uat_fixtures`

- `id` uuid primary key
- `fixture_type` text not null
- `status` text not null
- `owner_user_id` uuid not null
- `target_order_id` uuid null
- `target_bom_id` uuid null
- `target_baseline_id` uuid null
- `metadata` jsonb not null default '{}'::jsonb
- `created_at` timestamptz not null default now()
- `updated_at` timestamptz not null default now()
- `expires_at` timestamptz null
- `cleanup_requested_at` timestamptz null
- `cleanup_completed_at` timestamptz null

### `uat_fixture_assets`

- `id` uuid primary key
- `fixture_id` uuid not null references `uat_fixtures(id)` on delete cascade
- `asset_table` text not null
- `asset_id` uuid not null
- `asset_role` text not null
- `cleanup_mode` text not null
- `created_at` timestamptz not null default now()
- `cleaned_at` timestamptz null

### Optional `uat_fixture_audit`

Only if fixture cleanup needs a dedicated audit table beyond the existing application audit log.

## Security boundaries

- Fixture operations are server-side only.
- Normal UI actions must reject non-fixture IDs.
- Fixture creation must not call the normal order-intake workflow if that workflow emits milestones, procurement records, finance baselines, notifications, or approvals.
- Cleanup must accept a fixture ID, load owned assets from the registry, and refuse any row not registered to that fixture.
- Cleanup must be idempotent and transactional where possible.
- No service-role bypass is allowed in normal UI write paths.

## Workflow exclusions

The fixture must not generate:

- milestones
- procurement rows
- logistics rows
- finance postings
- approvals
- notifications
- customer-facing documents

## Analytics exclusions

The registry-owned fixture must not appear in:

- order counts
- production dashboards
- procurement queues
- logistics queues
- finance summaries
- customer target aggregates

This is achieved by keeping the fixture out of the normal business truth graph, not by adding a wide “exclude fixture” predicate to every query.

## Storage strategy

Upload UAT is deferred unless a fixture-only storage namespace can be proven safe.

Preferred future namespace:

- `uat/pr31/{fixtureId}/{uuid}.{extension}`

If the application cannot route fixture uploads into a fixture-only namespace without broad attachment-engine changes, upload write UAT stays blocked in this phase.

## Cleanup design

Cleanup flow:

1. require fixture ID
2. load `uat_fixtures`
3. verify type = `PR31_BUDGET_UAT`
4. verify status is `ACTIVE` or `CLEANUP_PENDING`
5. list owned assets from `uat_fixture_assets`
6. dry-run report
7. transactionally delete or restore only owned rows
8. mark assets cleaned
9. mark fixture `CLEANED`
10. write audit record

Cleanup must never accept a raw order ID as sufficient authority.

## Migration approval gate

This design needs an additive migration only.
The migration must not be applied to Production without separate CEO approval.

## Limitations

- Preview write UAT remains blocked until the fixture exists.
- Upload UAT remains blocked unless a safe fixture-only storage path is added.
- The isolated Preview Supabase target remains the long-term architecture fix.

## Next implementation files

- `supabase/migrations/20260718_pr31_uat_fixture_registry.sql`
- `lib/domain/pr31-fixture.ts`
- `scripts/test-pr31-fixture-contract.ts`
- optional fixture setup/cleanup server actions in a later implementation PR
