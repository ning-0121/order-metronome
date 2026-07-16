# QIMO OS Deployment Map

Verified 2026-07-16 using Git and Vercel metadata. Values of environment variables were not read.

| System | Vercel project | Production URL | Production deployment | Git SHA / branch | Database |
|---|---|---|---|---|---|
| Order Metronome | `order-metronome` (`prj_R4h6gqbNjBGUL9AA27YSm5mK25FT`) | `https://order.qimoactivewear.com` | `dpl_BYE14mM7VYXUS1MEdwNmkohHbtLE`, Ready | `060a88ebebd57cc04acd20cc4ec9d528e3d87b5c`, `main` | `scrtebexbxablybqpdla` |
| Finance | `finance-system` (`prj_QeJMZ4ACPG8GyqOAeDurcGcuwLuE`) | `https://finance.qimoactivewear.com` | `dpl_9XFCDKBtfu4aUD1ffj3Z2hSrobTr`, Ready | `ac426f6de8dd77e04d7bb2b4ab5788eaadd20681`, `main` | `qpoboelobqnfbytugzkw` |

## Environment topology

- Order Metronome Preview and Production use the same Supabase project. Preview is therefore not an isolated data environment.
- Finance has an independent Supabase Production database. No Finance Preview database was proven.
- Synthetic browser/E2E writes are prohibited until an isolated database or explicitly authorized disposable records exist.

## Environment variable names observed

Order Metronome Production includes: `OPENAI_API_KEY`, `QIMO_AI_PRIMARY_PROVIDER`, `QIMO_AI_FALLBACK_PROVIDERS`, `QIMO_MODEL_STRUCTURED_EXTRACTION`, `QIMO_MODEL_VISION`, Supabase public/service credentials, SMTP/IMAP credentials, cron/mail secrets, integration secrets, `FINANCE_SYSTEM_URL`, `OS_FINANCE_URL`, and ARAOS contract variables.

Finance Production includes: Supabase public/service credentials, `ANTHROPIC_API_KEY`, `ORDER_METRONOME_URL`, `INTEGRATION_API_KEY`, `INTEGRATION_WEBHOOK_SECRET`, `INTEGRATION_ALLOWED_ORIGINS`, `SYNC_VIA_SIGNED_API`, and WeCom credentials.

## Deployment risks

1. Preview/Production database sharing makes ordinary Preview acceptance capable of mutating Production truth.
2. Order Metronome has both `FINANCE_SYSTEM_URL` and `OS_FINANCE_URL`; code/config ownership must be consolidated after compatibility analysis.
3. Finance Vercel is configured as framework `Other` although the repository is Next.js; builds currently succeed but configuration drift should be removed deliberately.
4. Order build explicitly skips type validation and emits existing middleware/metadata warnings. Build success is not type-safety evidence.

## Release controls

- `main` Git push triggers Production for both repositories.
- Audit branch must produce Preview only; no merge or Production deployment is authorized.
- Database SQL remains CEO-operated in Supabase SQL Editor. No migration is executed by this audit.
