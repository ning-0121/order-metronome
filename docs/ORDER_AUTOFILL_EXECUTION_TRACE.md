# Order Autofill Execution Trace

## Current execution path

`LegacyOrderForm.handlePOFileChange`
→ `app/actions/po-parser.parsePO`
→ QIMO Runtime `qimoAI.generateObject(order.po.parse)`
→ OpenAI provider (configured logical model)
→ `po_parse_drafts.parsed_json`
→ `normalizePORecognition` compatibility boundary
→ Create Order form and editable `lineStyles`
→ Sales review
→ `app/actions/orders.createOrder`
→ `orders` + `order_line_items` + `order_customer_pos`
→ workflow/milestone initialization
→ BOM sync from reviewed line items
→ finance sync from the created order.

The recognition JSON copied to `orders.po_parse_snapshot` is immutable audit evidence. It is not downstream business truth.

## Files and responsibilities

- `components/order/LegacyOrderForm.tsx`: upload, employee-visible prefill, conflict preservation, reviewed submission.
- `app/actions/po-parser.ts`: authorization, checksum reuse, Runtime call, schema validation, draft/snapshot persistence.
- `lib/order/po-autofill.ts`: Claude-era aliases and Runtime V1 output normalize into one provider-neutral shape.
- `app/actions/orders.ts`: creates Order Master and initializes existing downstream records.
- `app/actions/order-line-items.ts`: reviewed SKU/style truth and BOM synchronization; snapshot is read-only.
- `lib/services/style-fabric-sync.ts`: reviewed order lines to BOM suggestions.
- `lib/services/finance-sync.ts`: Order Master to finance event/baseline.
- `app/actions/manufacturing-order.ts`: production sheet reads Order Master/lines/BOM and no longer reads AI snapshot.

## Snapshot lifecycle

One content checksum reuses an existing user draft. A successful parse stores provider/model/checksum provenance in `_recognition`. A snapshot is frozen at order creation (or first authorized parse for an existing order). It cannot be overwritten by later business edits. Corrections live in Order Master and domain records.

## Downstream consumers

- BOM: one-time synchronization from approved/reviewed `order_line_items`; editable domain truth thereafter.
- Procurement verification/procurement: reads BOM/material requirements and Order Master references; no PO reparse.
- Finance: order-created event from Order Master; no snapshot read.
- Production: Order Master, line items, BOM, milestones and approved operational inputs.
- QC: order/style/factory/workflow records.
- Shipment: Order Master, line items and approved packaging/shipment records.

## Corrected legacy violations

1. `refreezePoParseSnapshot` previously replaced AI evidence with current order lines. It now rejects overwrite while retaining the callable compatibility facade.
2. Manufacturing sheet generation previously read snapshot measurements. It no longer uses unreviewed AI measurements. Until approved size-chart data is connected to that export, measurement cells intentionally remain blank.

