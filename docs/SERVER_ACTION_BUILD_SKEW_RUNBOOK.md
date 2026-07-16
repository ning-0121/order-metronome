# Server Action build-skew runbook

## Incident evidence — 2026-07-16

- Production domain: `https://order.qimoactivewear.com`
- Active deployment at diagnosis: `dpl_BYE14mM7VYXUS1MEdwNmkohHbtLE`
- Active Git SHA: `060a88ebebd57cc04acd20cc4ec9d528e3d87b5c`
- Deployment created: `2026-07-16 02:43:19 EDT`
- Failing action ID `6060b1662cf44e9393d86927e769a00fab18070cbe` was recorded on that deployment at `2026-07-16 06:53:51 EDT` and `06:54:22 EDT`, route `/orders/new`.
- Two preceding Production deployments were created at `01:29:51 EDT` and `01:42:51 EDT`.
- Vercel Skew Protection is enabled with `skewProtectionMaxAge=43200` (12 hours), and automatic system environment exposure is enabled.
- Production environment-variable inventory did not contain `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.

The current source still exports `createOrder` from `app/actions/orders.ts`, and the client imports it statically from that module. There is no conditional or barrel export. Production HTML responds with `cache-control: public, max-age=0, must-revalidate`; Next.js chunks are content-versioned.

The registered `public/sw.js` was an independent skew path: it cached every successful same-origin GET, including documents, RSC responses, and `/_next` chunks, then could replay them on a network failure. The hotfix restricts it to deployment-neutral images/fonts/manifest/icon and deletes the prior cache during activation.

## Employee recovery

1. Open a new tab or hard-refresh `/orders/new`.
2. The hotfix preserves non-file form fields in `sessionStorage` only when the specific missing-Server-Action signature is detected.
3. Customer PO and internal quotation files are never persisted in browser storage and must be reselected.
4. The form is never resubmitted automatically.
5. If the first request succeeded but its response was lost, retrying the same pre-generated order number returns the existing order only when its creator and internal order number match.

## Encryption-key procedure (Production approval required)

Next.js 16.2.10 supports `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. The value must be a base64-encoded AES key of 16, 24, or 32 random bytes and must exist at build time. This is defense in depth in addition to Vercel Skew Protection.

After explicit Production approval, an authorized operator should run an interactive command locally, without copying the result into chat or a repository file:

```sh
openssl rand -base64 32 | vercel env add NEXT_SERVER_ACTIONS_ENCRYPTION_KEY production --sensitive
```

Then redeploy the approved Production SHA. Never use `vercel env pull`, shell tracing, repository `.env` files, or CI output for this key. Verify only that the variable name appears in `vercel env ls production`; never print its value.

## Deployment verification

- Verify Skew Protection remains enabled and its 12-hour window covers employee sessions.
- Confirm `autoExposeSystemEnvs=true`.
- Confirm the build manifest contains `app/actions/orders.ts#createOrder`.
- Confirm `/orders/new` HTML is not CDN-cached beyond revalidation.
- Confirm the active service worker does not cache documents, RSC, actions, or `/_next` assets.
- Perform an authenticated employee test with a non-Production fixture/customer; do not create a real order during diagnosis.
