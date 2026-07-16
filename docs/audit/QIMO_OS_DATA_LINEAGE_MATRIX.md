# QIMO OS Data Lineage Matrix

| Entity | Created / owned by | Storage | Editable / approved by | Consumers | Copy/reference and staleness risk |
|---|---|---|---|---|---|
| Customer | Sales/ARAOS | `customers`, customer memory/profile tables | Sales/managers | quote, order, analytics, finance | identity aliases across ARAOS/Order/Finance need contract keys |
| Quotation | Sales/Quoter | `quoter_quotes`, lines, version snapshots, cost baseline | Sales + price/finance gates | order, finance budget | snapshots are correct pattern; latest mutable quote must not replace frozen baseline |
| Customer PO file | Sales | storage + `order_attachments`/`order_documents` | uploader; deletion by authorized role | recognition and audit | original file is evidence only after creation |
| AI parse draft/snapshot | Runtime/Sales trigger | `po_parse_drafts`, `orders.po_parse_snapshot` | draft review by Sales; frozen snapshot should be immutable | Create Order prefill/audit only | **Production violation:** refreeze overwrites snapshot; manufacturing export reads snapshot measurements |
| Order Master | Sales-reviewed creation | `orders` | authorized business/order manager; approvals for controlled changes | every downstream module | authoritative order-level truth; multiple compatibility aliases exist |
| Order lines/SKU | Sales-reviewed form | `order_line_items`, PO link tables | order owner/managers | BOM, production, shipment, finance | current create path can succeed when line insert fails |
| Product/style | Product/business | `products`, definitions, variants/templates | product/business owners | order suggestions, BOM, QC | reusable template, not order-specific approval truth |
| BOM | business execution/procurement | `materials_bom`, product templates | domain users; approval semantics fragmented | MRP, procurement, production | sync rows are copied from line items and may be overwritten on next sync |
| Material requirement | deterministic MRP | requirement/plan tables | procurement review | purchase/readiness | derived; must retain full precision/unit/basis |
| Procurement candidate | document import | `accessory_import_candidates`, procurement items | authenticated reviewer | approved BOM/purchase workflow | extracted and approved values retained; never auto-PO |
| Supplier / PO | procurement | suppliers, purchase orders/lines | procurement + financial gates | receiving, finance | cross-system payable baseline needs idempotent source references |
| Factory/assignment | production supervisor/follow-up | factories, dispatch/logs, milestone ownership | production roles | scheduling/QC/analytics | recommendation must not hide eligible master records |
| Milestone/delay | template + responsible employee | milestones/logs/delay requests | role-specific actor/approver | workbenches, risk, runtime projection | runtime projection is eventually consistent; operational tables remain truth |
| QC inspection | QC trigger/actor | `qc_inspections`, attachments | QC/authorized override | shipment/release | no evidence yet that every shipment path enforces QC hold |
| Shipment | logistics | shipment batches/items/confirmations/docs | logistics + required approvals | order completion, finance | retry/partial shipment must use stable source IDs |
| Finance baseline/event | Order/procurement/shipment producers | Order finance event tables + Finance DB | Finance human approval | receivables/payables/profit/GL | two databases: message delivery and reconciliation, not distributed transaction |
| Attachment | employee/system | storage + attachment/document tables | authorized module roles | all modules | raw display filename must never be object key; duplicate attachment contracts exist |

## Field-level critical lineage

| Field family | Authoritative source after order creation | Derived consumers | Required invariant |
|---|---|---|---|
| quantity, set/piece basis | Order Master + reviewed lines | BOM/MRP, production, shipment, finance | one semantic basis; no double set multiplier |
| price, currency, amount | reviewed Order/approved finance truth | receivable, profit | Decimal/currency precision; restricted visibility |
| material consumption/unit/basis | approved BOM/domain record | MRP, production comparison, procurement | raw precision; loss once; no silent unit conversion |
| delivery/factory/ship dates | approved Order + scheduling domain | milestones, procurement required date, logistics, finance | timezone and amendment provenance |
| customer PO/style/SKU | reviewed Order/lines | documents, QC, shipment, finance | stable IDs and aliases; totals reconcile |
| AI provenance/confidence | frozen recognition snapshot | audit/prefill indicators only | never operational truth |

## Compatibility

Old aliases and nullable fields are actively used. No mass backfill or historical reinterpretation is safe. Compatibility normalization should occur at module boundaries, with new writes using canonical fields.
