# QIMO OS Source-of-Truth Register

`profiles.roles` owns role membership; `orders.owner_user_id` currently owns overall Business Execution responsibility; `milestones.owner_user_id/owner_role` owns only step execution. None is approval authority. Concurrent specialist responsibility lacks an independent truth source; an additive `order_responsibilities` migration is prepared but not applied or backfilled.

1. **Customer identity:** QIMO customer master, reconciled with signed ARAOS identity; free-text names are display aliases.
2. **Recognition:** PO draft/snapshot is immutable suggestion/evidence only.
3. **Order:** employee-reviewed `orders` plus `order_line_items` is final order truth.
4. **Reusable style knowledge:** Product/style master and approved templates.
5. **Materials:** approved order BOM and derived material requirements; not raw PO or AI output.
6. **Procurement:** approved procurement items/purchase orders/receipts; imports remain candidates until review.
7. **Production:** Order/BOM plus production assignment/schedule/milestone actuals.
8. **QC:** approved inspection result and evidence; production status alone is not QC release.
9. **Shipment:** approved shipment batch/items/documents, constrained by Order/SKU/QC.
10. **Finance:** Finance database records derived from approved Order/procurement/shipment/payment sources; Order Metronome copies/events are integration evidence, not posted ledger truth.
11. **Analytics:** derived queries/projections only; never writable business truth.

## Current violations and ambiguities

- `order-line-items.ts::refreezePoParseSnapshot` in Production main replaces AI evidence with edited line items.
- `manufacturing-order.ts` reads measurements from `po_parse_snapshot` for a production document.
- `createOrder` compensates some early failures by deleting the order, but later line/BOM/finance initialization failures are non-blocking. This permits incomplete downstream truth.
- Runtime confidence deliberately uses eventual projection hooks. Dashboards must expose projection age/failure rather than treating projection as synchronous truth.
- Finance integration is cross-database; warnings without durable pending/replay state are not sufficient delivery guarantees.

The first two violations have a tested compatibility fix on unmerged branch `fix/order-autofill-and-downstream-mapping` (`a1f4622`). They are not fixed in current Production main and must not be described as deployed.
