# QIMO OS Golden Path

Status values: **PASS** means a code-backed owner/action/output exists; **PARTIAL** means the path exists but is non-atomic, incomplete or awaits employee validation; **FAIL** means a business-truth violation or disconnected chain is evidenced.

| Step | Trigger / role | Input and source of truth | Action / output / next state | Evidence | Status |
|---|---|---|---|---|---|
| Lead/customer | ARAOS or Sales | ARAOS/customer master | signed handoff/customer ownership | contract handoff routes; `customers` | PARTIAL: upstream repo not deeply audited |
| Quotation | Sales/Quoter | customer/style/cost inputs | versioned quote and baseline | `quoter_*`, `quote_version_snapshot`, `order_cost_baseline` | PASS |
| Customer PO recognition | Sales | original attachment | `parsePO` -> QIMO Runtime -> `po_parse_drafts` | `LegacyOrderForm`, `po-parser.ts` | PASS with manual fallback |
| Recognition freeze/prefill | Sales | AI suggestion + checksum | editable Create Order form, snapshot evidence | `orders.po_parse_snapshot` | **FAIL in Production main**: refreeze can overwrite AI evidence; compatibility fix exists only on unmerged branch `a1f4622` |
| Create Order | Sales/merchandiser/manager | employee-reviewed form | `orders`, lines, milestones, downstream initialization | `orders.ts::createOrder` | **FAIL/P0 atomicity**: line-item/BOM/finance initialization errors are frequently logged as non-blocking, so an order may succeed without required lines/domain records |
| Internal number / Finance approval | Sales obtains number offline; Finance owns approval node | reviewed Order Master | active order + finance milestone | mandatory `internal_order_no`, milestone template | PARTIAL: offline number issuance is not an auditable system event |
| Product/style/SKU | Sales/product owner | reviewed line items/product master | `order_line_items`, variants/templates | line-item actions/products | PASS, compatibility aliases remain broad |
| BOM/material requirements | Business execution/procurement | reviewed order lines + approved product/BOM | BOM sync, deterministic MRP | `style-fabric-sync`, `materials_bom`, `material_requirements` | PARTIAL: sync-origin BOM rows can be overwritten on later line save; approval/version semantics are not unified |
| Procurement verification | Procurement | Order + approved BOM | candidate/reconciliation/review | procurement actions/tables | PASS for deterministic workflows; employee acceptance pending for new import UI |
| Supplier/purchase execution | Procurement + Finance gates | approved requirement/quote | purchase order, tracking, payable contract | `purchase_orders`, approval/payment actions | PARTIAL: many paths and fallback schemas; cross-system atomicity depends on outbox/reconciliation |
| Receiving/readiness | Warehouse/procurement | approved PO and receipts | inventory/readiness/shortage | goods receipt/inventory/MRP | PASS in unit regression; live RLS not exercised |
| Production intake/assignment | Production supervisor | active Order/milestones | follow-up assignment/factory selection | G-K Production release | PASS in code/tests; authenticated employee acceptance pending |
| Scheduling/cutting/online | Production follow-up | Order/BOM/unit truth | schedule, actual consumption, evidence | production actions/workbench | PARTIAL: decimal/unit rules fixed; manufacturing export still reads snapshot measurements in Production main |
| QC | QC | production triggers/order/style/factory | inspections/hold/reinspection/release | `qc.ts`, `qc_inspections` | PARTIAL: module exists; no complete task-driven QC workbench/golden E2E proof |
| Packing/shipment | Logistics | approved Order/SKU/packing/QC | packing list, shipment batches/docs | packing/shipment/logistics actions | PARTIAL: code exists; hold/idempotency/partial shipment need contract-level regression |
| Receivable/payable/profit | Finance human approver | approved Order/procurement/shipment/receipt | financial baselines, settlement, GL | separate Finance system | PARTIAL: strong engines exist, but Order-to-Finance delivery is non-atomic and Finance retains direct Anthropic paths |
| Completion/closure | accountable roles | completed milestones/shipment/payment | lifecycle completion/audit | orders/milestones/finance | PARTIAL: closure definitions differ by module and projections are eventually consistent |

## Expected exception paths

- AI failure: manual order entry remains available; no order is created from invalid extraction.
- Upload failure: storage key/error must be safe and UI loading state recover.
- Assignment/approval failure: action remains owned, buttons recover, no duplicate submission.
- Integration failure: local business transaction must expose pending/replay/reconciliation state; a warning log alone is insufficient evidence of delivery.
- QC rejection: shipment release must remain blocked until approved reinspection/override.

## Golden-path conclusion

The path is operational but not yet enterprise-continuous. Production can process daily work, but Order creation atomicity, snapshot truth separation, QC operating proof and cross-database reconciliation prevent a full PASS.
