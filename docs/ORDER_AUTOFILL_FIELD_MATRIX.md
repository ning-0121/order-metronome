# Order Autofill Field Matrix

| Source | Source Field | Destination Module | Destination Field | Transform | Trigger | Editable | Frozen/Linked | Existing Implementation | Current Status | Regression Test |
|---|---|---|---|---|---|---|---|---|---|---|
| PO snapshot | order_no / po_number / po_no | Create Order | customer_po_number | aliases; multiple PO numbers joined | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | customer_name / customer / buyer | Create Order | customer_name | first recognized customer; do not overwrite employee value | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | delivery_date / ship_date | Create Order | etd, warehouse_due_date, factory_date | normalize date; earliest across POs | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | order_date / po_date | Create Order | order_date | normalize ISO date | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | styles/items/products | Create Order | order_line_items | normalize old aliases; preserve PO provenance | parse success | Yes | one-time | lineStyles editor | preserved | po-autofill |
| PO snapshot | style_no / style_number | Create Order | style_no/style_count | normalized; unique count | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | colors/variants + sizes | Create Order | SKU matrix | object/array aliases; ratio-to-pieces guard in UI | parse success | Yes | one-time | LineItemMatrixEditor | preserved | existing parser tests |
| PO snapshot | total_qty/quantity | Create Order | total_quantity | sum styles across POs | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | material/composition + weight | Create Order lines | fabric_name | concatenate non-empty values | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | unit_consumption | Create Order lines | fabric_consumption/unit | parse explicit kg/metre/yard/area only | parse success | Yes | one-time | LegacyOrderForm | preserved | po-autofill |
| PO snapshot | packaging/color packaging | Create Order lines | color remark | text copy | parse success | Yes | one-time | LegacyOrderForm | preserved | parser schema tests |
| PO snapshot | unit_price/currency/total_amount | Create Order | reviewed commercial fields | numeric/currency validation | submit | Yes | one-time | FormData/order create | audit gap: some values not visibly editable | checklist |
| PO snapshot | incoterm | Create Order | incoterm | supported option only | parse success | Yes | one-time | controlled form | partial/manual when unsupported | checklist |
| PO snapshot | payment_terms | Create Order | payment terms | text | parse success | Yes | one-time | schema extracts | no dedicated Order Master column found; manual/domain workflow | checklist |
| Order Master | customer/currency/amount/terms | Finance | finance baseline/event | existing finance sync | order created | Domain-edit | event/copy | finance-sync | preserved | finance tests |
| Reviewed order lines | styles/colors/sizes/fabric | BOM | materials_bom suggestions | style-fabric sync | line save/create | Domain-edit | one-time init | style-fabric-sync | preserved | BOM tests |
| Order + approved BOM | qty/spec/unit/date | Procurement | requirements/candidates | deterministic calculation/match | reviewed workflow | Domain-edit | derived | procurement actions | preserved | procurement tests |
| Order Master/lines | order/style/qty/dates | Production | task/workflow/sheet | existing initialization | order created | Domain-edit | linked/derived | orders + manufacturing | snapshot bypass removed | boundary test |
| Order/style/factory | approved operational data | QC | inspection context | linked | workflow trigger | Domain-edit | linked | QC actions | preserved | workflow tests |
| Order/lines/packaging | approved operational data | Shipment | shipment docs | linked/derived | shipment workflow | Domain-edit | linked | shipment actions | preserved | regression checklist |

Fields not reliably present in the current PO parser or Order Master (brand, salesperson/team assignment, destination/ship-to, season, gender, fit, commission/tax rules, factory, QC sampling rules) remain employee/product-master/domain inputs. They must not be invented by AI.

