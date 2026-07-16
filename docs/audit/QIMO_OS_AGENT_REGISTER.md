# QIMO OS Agent Register

| Agent/automation | Trigger | Input/source | Provider/model | Tools/writes | Approval/failure |
|---|---|---|---|---|---|
| PO recognition | Sales upload | PO file | QIMO Runtime, logical structured/vision model, OpenAI primary | stores draft/snapshot only | schema validation; manual fallback; checksum cache |
| Agent chat | employee request/API | scoped order/system context | direct Anthropic legacy | chat response + AI usage log | no Runtime metadata standard; key absence fails |
| Smart insights/capacity | dashboards/actions | operational aggregates | direct Anthropic legacy | recommendations/usage logs | deterministic fallback in some paths |
| Email matcher/draft/learning | cron/mail actions | mail + order/customer context | direct Anthropic legacy | matching/drafts/learning records | email sends controlled separately; redaction coverage unproven |
| Daily briefing | cron | orders/milestones/risks | direct Anthropic legacy | briefing/notifications | cron auth/feature flags; paid repetition controls vary |
| Compliance checker | cron | operational data | direct Anthropic legacy | findings/suggestions | no unified tool classification |
| Suggestion engine | cron/action | milestones/order context | deterministic + optional AI enhance | `agent_actions` pending suggestions | explicit employee execute action |
| Agent action executor | authenticated employee | pending action payload | deterministic tool execution | can nudge, note, assign, block/draft/escalate within switch | status/replay/rate limits; centralized safety classification absent |
| Runtime confidence | milestone/delay/amendment hooks | operational truth | deterministic | append/projection | fire-and-forget; eventual consistency |
| Finance document extractor | document upload | financial document | direct Anthropic | extracted suggestion/action candidates | Finance human approval before execute |
| Finance document executor | Finance-approved actions | confirmed fields | deterministic | creates/updates finance domain records | finance/admin role; authentic actor; partial multi-action risk |
| Finance collection/profit/breaker agents | authenticated `/api/agents/run` | financial truth | deterministic | risk events and agent action rows | **any authenticated user can trigger**; no role gate |

## Provider footprint

- QIMO Runtime is implemented and tested for PO text/vision/structured extraction.
- Provider boundary gate reports 18 audited legacy bypasses in Order Metronome.
- Finance directly imports Anthropic in extractors and AI chat/batch routes.
- Actual provider/model/usage metadata is consistent only in QIMO Runtime paths.

## Cost controls

- PO checksum reuse and frozen recognition are the correct one-file/one-recognition design.
- Runtime has timeout/retry/usage metadata; validation smoke must explicitly disable retries/fallback.
- Legacy Agent cron paths do not share one enterprise budget registry; per-scene feature flags/rate controls are fragmented.
- Identical mail/document recognition dedupe is not proven across all legacy paths.
