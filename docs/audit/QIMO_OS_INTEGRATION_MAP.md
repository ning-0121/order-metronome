# QIMO OS Integration Map

## Primary integration graph

```text
ARAOS / Customer Development
        | signed handoff contract
        v
Order Metronome (enterprise operational host)
        | signed order/attachment/finance events
        v
Finance System (independent financial truth)

Order Metronome -> Supabase QIMO DB/Auth/Storage
Finance System   -> Supabase Finance DB/Auth/Storage
Both             -> Vercel, email/WeCom integrations
Order Metronome  -> QIMO AI Runtime -> OpenAI primary / audited legacy Anthropic paths
Finance          -> document and recommendation agents -> Anthropic SDK currently present
```

## Contract inventory

| Producer | Consumer | Evidence | Authentication / idempotency |
|---|---|---|---|
| ARAOS | Metronome | `/api/contract/v1/handoff/araos`, `/api/os/handoff`, `araos_handoffs_inbox` | contract key/secret; inbox is intended idempotency boundary |
| Metronome | Finance | `/api/integration/orders`, finance snapshot contract, purpose requests, attachments, finance callback | signed API/webhook secrets; callback/outbox tables exist |
| Finance | Metronome | Finance `integration/webhook`, `integration/sync`, `integration/finance-progress`, approval endpoints | integration API key/webhook secret; exact retry semantics audited in cross-module contracts |
| Metronome | OpenAI/Anthropic | `lib/ai/runtime/providers`, legacy audited bypass register | QIMO Runtime gives provider metadata; 18 legacy bypasses remain |
| Both | Supabase | server/user clients | user RLS for employee access; service role only server-side |
| Both | Email/WeCom | cron/mail routes and Finance WeCom library | secrets in Vercel; real sends excluded from audit tests |

## Integration failure boundaries

- `integration_outbox`, `integration_callback_events`, request/access logs and reconciliation actions indicate intentional idempotency/audit design.
- Several Runtime Confidence hooks are explicitly fire-and-forget and non-blocking. Projection staleness is therefore expected on failure and must be observable/reconcilable.
- A successful HTTP call is not proof of atomic cross-database commit. Order and Finance are separate databases; signed messages, idempotency keys and reconciliation are required.
- Environment naming drift and duplicated endpoints are configuration risks. Consumers must fail closed for write contracts and expose health/replay state.

## Security boundary

- Do not expose integration secrets in client bundles or logs.
- Service-role clients must remain server-only.
- Finance AI output is suggestion-only; financial writes require authenticated Finance approval.
- Cross-system actor identity must be derived from authenticated context or signed system identity, never a client-supplied user id.
