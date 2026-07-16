# QIMO P0 Production approval packet — 2026-07-16

## Candidate

- Branch: `release/p0-20260716`
- Base: `origin/main@59ceaa0f84e359a4d180fc5b3c802bd30b6c5507`
- Release assembly: `1bb83a5`
- PO fail-closed correction: `4c5bf04`
- Production deployment is **not authorized** by this packet.

The authoritative file list is the output of:

```sh
git diff --name-status origin/main...release/p0-20260716
```

It covers QIMO Runtime/provider adapters, PO parser/verification, material calculation, technical-confirm storage keys, size-chart parsing/review, accessory candidate import/review, tests, documentation and the two already-applied migration files. It excludes all uncommitted production-center G–K changes.

## Database state

The Preview and Production app share Supabase project `scrtebexbxablybqpdla`. The CEO already manually applied and verified:

- `20260715_size_chart_import_status.sql`
- `20260715_accessory_workflow_fields.sql`

No migration command is part of deployment. No historical cost/consumption basis was backfilled.

## Approval boundary

CEO approval is required for all of:

1. merge the release PR into `main`;
2. allow the GitHub/Vercel Production deployment;
3. execute the post-deployment artificial-data checks;
4. roll back to the recorded previous deployment if a stop condition occurs.

No Supabase migration, production data rewrite, or main force-push is requested.

## Stop/rollback conditions

- PO path executes Anthropic or silently falls back;
- material/cost values double for set orders;
- schema validation fails but data is persisted;
- technical-confirm object key contains the raw filename;
- candidate import creates a purchase order without approval;
- any unexpected database write occurs during the artificial PO prefill check.

On any condition, stop acceptance and restore deployment `dpl_B1YoXgaGatF5DM4hx9ALBqwWZ1h3`. Database schema remains because it is additive and backward-compatible.

## Quality gates

- P0 targeted tests: passed.
- Repository `npm run check` full scripted regression: passed.
- Provider boundary gate: passed.
- Production build: passed, 95/95 static pages generated.
- `git diff --check`: passed.
- Scoped lint of the release files passed before reconciliation; a direct whole-file lint of the legacy `BomTab.tsx` reports its existing `no-explicit-any`/Hook dependency debt. The release reconciliation fixed a duplicate Hook declaration caught by build; it did not attempt a broad lint rewrite. Build and regression are green.
