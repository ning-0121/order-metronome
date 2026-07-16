# Production Center G–K Recovery

Recovered on 2026-07-16 from `/Users/ning/Projects/order-metronome` on branch `fix/production-center-workflow-and-ai` at base `29ef055`.

## Recovery inventory

| Issue | Recovered files | State at recovery | Intent |
|---|---|---|---|
| G Delay approval | `app/actions/delays.ts`, `lib/domain/deferral-routing.ts`, `components/DelayRequestActions.tsx`, `components/DelayRequestDetail.tsx`, `components/DelayRequestsList.tsx`, `app/orders/[id]/page.tsx` | Partial | Route production execution delay to production supervisor, append sales manager only when customer commitment changes, align reject permission, prevent self approval, restore loading state. |
| H Internal order number | `app/actions/production-scheduling.ts`, `components/production/SchedulingBoard.tsx`, `app/actions/production-center.ts`, `app/production/ProductionCenterClient.tsx` | Partial | Fetch and show distinct internal number, customer PO and style; remove candidate truncation. Search still missing. |
| I Production assignment | `app/actions/milestones.ts`, `components/MerchandiserAssign.tsx`, `app/production/ProductionCenterClient.tsx` | Partial/speculative | Normalize only known production execution nodes when legacy templates have no assignable production node; expose assignment action to supervisor. Audit fields, intake state and duplicate/reassignment rules still require review. |
| J Consumption decimal/unit | `app/actions/quote-baseline.ts`, `app/actions/milestones.ts`, `components/MilestoneActions.tsx`, `lib/domain/checklist.ts` | Partial | Keep decimal input as a string, inherit unique approved quote baseline and unit, block comparison on unit mismatch. Round-trip and compatibility tests missing. |
| K Factory completeness | `app/actions/production-scheduling.ts`, `components/production/SchedulingBoard.tsx` | Partial | Stop slicing recommendations to eight and add search. Eligibility/exclusion semantics and tests still require review. |
| Minimum workbench | `lib/production/workbench.ts`, `components/production/RoleTaskWorkbench.tsx`, `app/production/page.tsx`, `lib/production/__tests__/workbench.test.ts`, production guards | Partial | Pure task projection and supervisor/follow-up/QC entry; must narrow to required supervisor queues and add missing delay/exception/today queues. |

Three PO Runtime/manual-fallback diffs were also present. They belong to the earlier A–F release and are not G–K intent; after updating from `origin/main`, only true G–K deltas may remain in final commits.

## Safe recovery decision

1. Preserve the complete interrupted tree in a WIP commit before integration.
2. Merge current `origin/main` rather than rebasing unpublished recovery state.
3. Resolve conflicts in favor of approved A–F Production behavior plus the narrowly scoped G–K delta.
4. Do not merge or cherry-pick `fix/order-autofill-and-downstream-mapping`.

## Missing validation at recovery

- No authenticated Preview acceptance was completed.
- Existing workbench tests used Vitest imports although repository tests use Node test/tsx.
- No focused RBAC, scheduling search, assignment audit, decimal/unit or factory eligibility tests existed.
- No database migration had been prepared or applied for G–K.

## Final implementation decisions

- Delay authorization is exact-step RBAC: admin may override; production supervisor cannot impersonate sales manager.
- Existing milestones remain the assignment truth. Only known production execution nodes may be normalized from legacy ownership; fixed supervisor/business/finance/QC nodes are excluded.
- Decimal values remain strings through UI/checklist JSON and are validated to six decimal places before numeric comparison.
- Units normalize only equivalent labels; incompatible dimensions are never converted.
- Factory capability/capacity is recommendation metadata, not a filter. Only active/trial, non-deleted factory master records enter the selectable pool.
- Supervisor queues are projections over orders, milestones, assignments and pending delays; no duplicate workflow status table was introduced.
