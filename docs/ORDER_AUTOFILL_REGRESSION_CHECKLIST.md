# Order Autofill Regression Checklist

- [ ] One checksum creates/reuses one recognition draft; reload makes no paid call.
- [ ] Claude-era aliases (`po_number`, `buyer`, `style_number`, `variants`, size arrays) normalize correctly.
- [ ] Customer, PO number, dates, style/color counts, quantity and SKU matrix prefill.
- [ ] Style, product, material, fabric weight, explicit consumption/unit and packaging prefill.
- [ ] Price, currency, amount, incoterm and payment terms are surfaced for employee review where supported.
- [ ] Existing employee values are never overwritten by AI prefill.
- [ ] AI failure leaves manual Create Order available.
- [ ] Frozen snapshot retains AI value and provider/checksum provenance.
- [ ] Frozen snapshot cannot be overwritten with edited order lines.
- [ ] Create Order submits reviewed form values and reviewed line items.
- [ ] Old orders and NULL/new fields render without backfill.
- [ ] BOM initializes/syncs from reviewed order lines, not snapshot.
- [ ] Procurement verification reads approved BOM/order values and does not call AI again.
- [ ] Procurement never creates a purchase order without approval.
- [ ] Finance reads Order Master and approved finance records, not snapshot.
- [ ] Production reads Order Master/lines/BOM/workflow; no snapshot measurement truth.
- [ ] QC reads order/style/factory and approved inspection requirements.
- [ ] Shipment reads order/lines/approved packaging and shipment data.
- [ ] No downstream source file imports provider SDK or provider key.
- [ ] Partial order/downstream initialization failures are reported and do not masquerade as success.

