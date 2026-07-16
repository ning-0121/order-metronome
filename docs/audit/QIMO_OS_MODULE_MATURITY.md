# QIMO OS Module Maturity Evidence

Scores are 0–5: 0 absent, 1 shell, 2 partial, 3 usable with material gaps, 4 strong/controlled, 5 proven end-to-end including failure recovery.

| Module | Score | Evidence-backed assessment |
|---|---:|---|
| Business Development / Sales | 3.0 | PO/quote/order UI and manual AI fallback exist; upstream ARAOS depth and offline internal-number handoff remain gaps |
| Order Execution | 3.5 | mature milestone/risk/delay functionality and regression suite; aliases/templates/projections create consistency debt |
| Product / BOM | 3.5 | version/snapshot/MRP and set/precision tests are strong; sync overwrite and approval semantics need consolidation |
| Procurement | 3.5 | broad import/approval/PO/receipt/inventory capabilities; receipt-to-inventory consistency and fail-open budget checks are material risks |
| Production | 3.5 | G-K fixes and supervisor workbench deployed; employee acceptance and unified production lifecycle still missing |
| QC | 2.5 | inspection actions/table exist; task/workflow and shipment-hold E2E proof incomplete |
| Logistics | 2.5 | shipment batches/docs/confirmations exist; partial shipment, QC hold and retry invariants unproven |
| Finance | 3.5 | extensive independent finance/control implementation; integration atomicity, Agent auth and provider governance remain gaps |
| AI/Agents | 2.5 | QIMO Runtime is strong for PO; 18 Order legacy bypasses plus Finance direct Anthropic and write-capable Agent surfaces remain |
| Analytics/KPI | 2.5 | many dashboards and projection engines; canonical KPI definitions/inclusion rules not centralized |

## UI-complete versus business-complete

- Procurement, QC, Logistics and Finance have substantial pages and actions, but UI presence is not end-to-end proof.
- The strongest deterministic domains are MRP, scheduling and core finance calculation engines because they have explicit regression suites.
- The weakest chains are Order atomic initialization, receipt-to-inventory readiness, QC-to-shipment release, and cross-database settlement reconciliation.
