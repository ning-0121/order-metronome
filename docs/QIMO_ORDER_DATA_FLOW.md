# QIMO Order Data Flow

```text
Customer PO
  ↓ one AI recognition (checksum-idempotent)
Frozen recognition snapshot (suggestion + provenance)
  ↓ prefill only
Create Order form
  ↓ Sales reviews and edits
Order Master + reviewed order lines
  ├─ BOM / approved materials
  ├─ procurement verification / procurement
  ├─ finance
  ├─ production
  ├─ QC
  └─ shipment
```

Rules:

- AI never creates final business truth or a purchase order.
- Page refresh/reload may reuse the stored recognition draft; it must not make another paid request for the same checksum.
- The original AI value remains in the frozen snapshot. Employee-approved values remain in Order Master/domain tables.
- Downstream modules must never reparse the same PO or read the snapshot as operational truth.
- Product/style master provides reusable templates; an order-specific approved domain record supersedes a suggestion.
- Old snapshots remain readable through aliases; no historical backfill or reinterpretation is required.

