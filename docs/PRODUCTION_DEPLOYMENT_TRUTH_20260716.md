# Production deployment truth — 2026-07-16

## Verified deployment state

- Production alias: `https://order.qimoactivewear.com`
- Production deployment: `dpl_B1YoXgaGatF5DM4hx9ALBqwWZ1h3`
- Production Git source: `main@59ceaa0f84e359a4d180fc5b3c802bd30b6c5507`
- Latest Preview at audit time: `dpl_FK1trHknfNLo88Axaohbw1jLdqT9`
- Latest Preview Git source: `feat/po-history-learning-v1@ccde8d093fe2e50ce1f4095afa04e8e61291dc77`
- Tested material-workflow Preview: `dpl_HZgMYWNEPdXh1kEyLChb1xbKAC8T`, sourced from `fix/set-material-and-attachment-workflows`
- Production and Preview use the same Supabase project. The two additive workflow migrations were manually applied already; deployment does not apply them.

Passing tests on a feature branch do not imply merge or Production deployment. At audit time none of the commits below was an ancestor of `origin/main`.

## Commit graph

```text
59ceaa0 origin/main = Vercel Production
  \
   1bb83a5 release assembly (release/p0-20260716)
     + 4c5bf04 fail-closed PO recognition correction
  /
29ef055 fix/set-material-and-attachment-workflows (pushed, Preview only)
  f6907e4 reviewed material import workflows
  e99592b idempotent workflow policies
  9e2daa1 accessory schema hardening
  7e4ddd4 size-chart schema hardening
  03ebbec size-chart parsing/duplicate handling
  d902e57 set material and cost calculation
  ab47129 safe technical-confirm object keys
  290be3e PO verification via Runtime
  c0b4554 QIMO AI Runtime

ccde8d0 feat/po-history-learning-v1 = latest Preview at audit time

29ef055 fix/production-center-workflow-and-ai (local branch base)
  + uncommitted G–K work (local only; excluded from release)
```

## Employee issue matrix

| Issue | Implementing commit | Source branch | Pushed | In main | In Production | Implementation truth |
|---|---|---|---:|---:|---:|---|
| A Set material doubled | `d902e57` | fix/set-material-and-attachment-workflows | yes | no | no | completed and tested; included in release |
| B Processing/accessory cost per set | `d902e57` | fix/set-material-and-attachment-workflows | yes | no | no | completed and tested; included in release |
| C Chinese tech-confirm key | `ab47129` | fix/set-material-and-attachment-workflows | yes | no | no | completed and tested; included in release |
| D Size-chart recognition | `03ebbec`, `7e4ddd4`, `f6907e4` | fix/set-material-and-attachment-workflows | yes | no | no | deterministic parse/status/review implemented; included in release |
| E Accessory extended fields | `9e2daa1`, `f6907e4` | fix/set-material-and-attachment-workflows | yes | no | no | nullable fields/UI/export implemented; included in release |
| F Procurement candidate review | `f6907e4`, `29ef055` | fix/set-material-and-attachment-workflows | yes | no | no | XLSX parser/basic reviewed candidate workflow implemented; included in release |
| G Delay approval mismatch | none | local fix/production-center-workflow-and-ai | no | no | no | work in progress only; excluded |
| H Scheduling internal order number | none | local fix/production-center-workflow-and-ai | no | no | no | work in progress only; excluded |
| I Supervisor assignment | none | local fix/production-center-workflow-and-ai | no | no | no | work in progress only; excluded |
| J Decimal/unit handling | none | local fix/production-center-workflow-and-ai | no | no | no | work in progress only; excluded |
| K All factories visible | none | local fix/production-center-workflow-and-ai | no | no | no | work in progress only; excluded |
| L PO Anthropic error/bypass | `c0b4554`, `290be3e`, release correction `4c5bf04` | feat/qimo-ai-runtime-v1 + release/p0-20260716 | release push pending | no | no | business parser/verification use Runtime; release disables fallback and emits safe generic errors |

## Release contents

The release branch is based on current `origin/main` and includes only the net, cleaned implementation from the tested AI/material branch plus the fail-closed PO correction. Temporary smoke endpoints and middleware bypasses are absent. G–K local work is absent.

Database migrations already applied manually:

- `20260715_size_chart_import_status.sql`
- `20260715_accessory_workflow_fields.sql`

Both were additive/idempotent and did not backfill historical business meaning.

## Rollback

1. Before Production approval, record the current Production deployment ID (`dpl_B1YoXgaGatF5DM4hx9ALBqwWZ1h3`).
2. If post-deploy checks fail, use Vercel rollback/promote to restore that exact known-good deployment; do not reverse the additive database schema.
3. If code rollback must use Git, revert the release merge on `main` in a new reviewed commit. Do not rewrite main history.
4. Keep new nullable tables/columns in place; older code ignores them.

## Required post-deployment checks

1. Confirm Production deployment SHA equals the approved release merge SHA.
2. Upload one artificial PO and verify OpenAI metadata, structured prefill and manual fallback; do not submit the order.
3. Verify `0.35 + 0.32` times 7,700 sets equals 5,159 kg and per-set costs are not doubled.
4. Upload an artificial Chinese-named JPG/PDF technical confirmation and remove it afterward.
5. Upload an artificial size-chart XLSX, verify `NEEDS_REVIEW`, duplicate detection and manual approval.
6. Import an artificial accessory XLSX and verify candidates require explicit review and create no purchase order.
7. Check logs for safe error categories only; confirm no secret, prompt or full document payload is logged.

