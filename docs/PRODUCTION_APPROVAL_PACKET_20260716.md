# QIMO P0 Production approval packet — 2026-07-16

## Candidate

- Branch: `release/p0-20260716`
- Base: `origin/main@59ceaa0f84e359a4d180fc5b3c802bd30b6c5507`
- Release assembly: `1bb83a5`
- PO fail-closed correction: `4c5bf04`
- Approval PR: `https://github.com/ning-0121/order-metronome/pull/20`
- Stable release Preview alias: `https://order-metronome-git-release-p0-20260716-alexs-projects-f97c1255.vercel.app`
- Production deployment is **not authorized** by this packet.

The authoritative Production diff contains these files:

```text
.gitignore
app/actions/accessory-import.ts
app/actions/bom.ts
app/actions/manufacturing-order.ts
app/actions/order-share-docs.ts
app/actions/po-parser.ts
app/actions/po-verify.ts
app/actions/procurement-items.ts
app/actions/size-chart.ts
app/actions/tech-confirm.ts
components/BulkConsumptionEditor.tsx
components/order/LegacyOrderForm.tsx
components/tabs/BomBudgetEntry.tsx
components/tabs/BomTab.tsx
components/tabs/ProcurementItemsTab.tsx
docs/AI_RUNTIME_ENVIRONMENT.md
docs/BUG_REPORT_1022961.md
docs/PO_RECOGNITION_EXECUTION_TRACE.md
docs/PREVIEW_ACCEPTANCE_1022961.md
docs/PRODUCTION_APPROVAL_PACKET_20260716.md
docs/PRODUCTION_DEPLOYMENT_TRUTH_20260716.md
lib/ai/runtime/**
lib/ai/scenes/po-schema.ts
lib/domain/quantity-calculation.ts
lib/domain/__tests__/quantity-calculation.test.ts
lib/parsers/accessory-import.ts
lib/parsers/size-chart.ts
lib/parsers/__tests__/**
lib/services/mrp.ts
lib/storage/safe-object-key.ts
lib/storage/__tests__/safe-object-key.test.ts
package.json
package-lock.json
scripts/ai-runtime-smoke.ts
scripts/check-ai-provider-boundaries.ts
scripts/test-bugfix-migrations.ts
scripts/test-material-workflow-boundaries.ts
supabase/migrations/20260715_accessory_workflow_fields.sql
supabase/migrations/20260715_size_chart_import_status.sql
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
