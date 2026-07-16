# QIMO OS Attachment and Document Audit

## Upload families

Customer PO, build documents, milestone evidence, technical confirmation, size chart, accessory artwork, procurement documents, product images, QC evidence, logistics evidence and Finance documents all have separate upload implementations.

## Controls found

- Technical confirmation uses server-generated `{orderId}/tech-confirm/{uuid}.{validatedExtension}` and preserves display name.
- Size chart uses checksum/status/manual review and removes orphan storage on row failure.
- File naming and extension helpers exist for milestone documents.
- Storage/database compensation exists in some server actions.

## Findings

1. **P0-SEC-ATT-01:** `product-images` is explicitly public, but logistics shipment evidence and some BOM/procurement attachments are uploaded there and exposed with `getPublicUrl`. RLS on metadata cannot protect the object.
2. **P1-ATT-02:** upload logic is duplicated across client components. Several paths validate only the extension parsed from the filename and trust browser MIME.
3. **P1-ATT-03:** some paths leave orphan objects when metadata insertion fails; cleanup is inconsistent.
4. **P1-ATT-04:** many order documents use `getPublicUrl`; bucket privacy is not defined in migrations (manual bucket setup). Production bucket metadata must be read-only verified before claiming privacy.
5. **P1-ATT-05:** logistics attachment JSON stores URL/display name but not a private storage object key, making safe signed-download migration harder.
6. **P2-ATT-06:** native alert/confirm and raw storage errors remain in changed upload flows.

## Safe remediation boundary

Immediately stop new sensitive evidence uploads to public `product-images`; create a private evidence bucket/contract or use verified-private `order-docs`, store generated object key plus display name, serve short-lived signed URLs, and migrate historical objects only under a separately approved inventory/backfill plan. Do not delete or move Production objects during this audit.
