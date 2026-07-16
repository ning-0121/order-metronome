# QIMO OS Agent Permission Matrix

| Capability | Class | Allowed behavior | Human gate | Current conformity |
|---|---|---|---|---|
| read operational/financial context | READ_ONLY | scoped query and analysis | authenticated visibility | partial; service-role context loaders require careful scoping |
| PO/document extraction | DRAFT | return schema-validated candidate | employee review | QIMO PO PASS; Finance direct provider but human review exists |
| email/message draft | DRAFT | produce unsent text | employee send approval | partial; send boundary requires full test |
| assignment/status/data write | WRITE_REQUIRES_APPROVAL | deterministic action after explicit approval | authenticated authorized actor | QIMO Runtime tool gate exists; legacy Agent executor has its own switch rather than shared gate |
| Finance create/update/post | FORBIDDEN for AI | AI may only draft/compare/warn | Finance human route performs write | documented Finance executor conforms; Agent scan writes risk/action metadata |
| deploy, destructive DB, payment, purchase, shipment release | FORBIDDEN | never autonomous | separate business/CEO approval | no AI tool should expose these directly |

## Findings

- **P1-AGENT-01:** Agent action types are not registered in the Runtime tool-safety registry; two authorization systems can drift.
- **P1-AGENT-02:** Finance `/api/agents/run` lacks Finance/admin role authorization and writes database risk/action records.
- **P1-AGENT-03:** 18 Order bypasses and Finance direct Anthropic paths lack unified fallback disclosure, usage metadata, redaction and cost policy.
- **P1-AGENT-04:** cron Agent budgets/dedupe are fragmented, creating repeated paid-call risk.
- **P2-AGENT-05:** audit logs record results, but prompt/content redaction is not centrally enforced outside QIMO telemetry.

## Mandatory invariant tests

Mock every tool and assert: unauthenticated denial, wrong-role denial, no self-approval, Finance write forbidden from AI context, explicit approval required, replay is idempotent, actual actor is server-derived, provider fallback is visible and secret/prompt redaction holds.
