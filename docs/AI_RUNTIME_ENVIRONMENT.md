# QIMO AI Runtime environment

QIMO AI Runtime reads Provider credentials and routing configuration only from deployment environment variables. Do not commit `.env*` files or real credentials.

## Provider credentials

| Variable | Purpose | Safe placeholder |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI Project API key used only by the OpenAI provider adapter | `<openai-project-key-in-secret-manager>` |
| `ANTHROPIC_API_KEY` | Optional Anthropic compatibility credential | `<anthropic-key-in-secret-manager>` |

Provider keys must be entered through the deployment platform's protected environment-variable interface. Never paste them into source, documentation, issues, chat, logs, or build output.

## Routing policy

| Variable | Purpose | Example placeholder |
|---|---|---|
| `QIMO_AI_PRIMARY_PROVIDER` | Explicit primary Provider | `<provider-name>` |
| `QIMO_AI_FALLBACK_PROVIDERS` | Ordered comma-separated fallback Providers; blank disables fallback | `<provider-list-or-empty>` |

An empty fallback list is valid. A Provider must not be added unless its adapter, credential, model mapping, and required capabilities have all been validated.

## Logical model registry

| Variable | Capability | Example placeholder |
|---|---|---|
| `QIMO_MODEL_FAST_TEXT` | Low-latency text generation | `<account-verified-model-id>` |
| `QIMO_MODEL_REASONING` | Reasoning and finance read-only suggestions | `<account-verified-model-id>` |
| `QIMO_MODEL_VISION` | Image understanding | `<account-verified-model-id>` |
| `QIMO_MODEL_STRUCTURED_EXTRACTION` | Strict structured extraction, including PO parsing | `<account-verified-model-id>` |

Model IDs are deployment configuration, not source defaults. Preview must validate account access and capability support before the same value is considered for Production. Missing model configuration fails closed and reports only the missing variable name.

## Paid smoke-test interlock

| Variable | Purpose | Default behavior |
|---|---|---|
| `QIMO_ALLOW_PAID_SMOKE_TEST` | Explicitly permits one controlled real API smoke request | Absent/anything except `true`: skip without an API call |

The smoke script calls the OpenAI adapter directly with SDK retries disabled and fallback disabled. It must use non-sensitive fixed input, must not write to a database, and must not print prompts, response bodies, or credentials.

## Vercel environment scope

Configure and validate new Runtime variables in **Preview only** first. Do not add or change Production values until Preview build, structured smoke, and sanitized PO validation have all passed and Production rollout has separate approval.
