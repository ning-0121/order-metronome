# QIMO OS Role / Permission Matrix — Stage 1 Snapshot

Date: 2026-07-19

Source references:

- `docs/org-role-config-2026-07.md`
- `docs/org-system-role-mapping.md`
- `lib/domain/roles.ts`

## Role inventory

| Role | Primary domain | Current audit focus |
|---|---|---|
| admin | cross-system / governance | full visibility, overrides, approvals |
| sales_manager | business development | PO handoff, pricing, delay approval |
| sales | business development | own-order visibility, pre-PO support |
| order_manager | order execution leadership | order queue, delay approval, reassignment |
| merchandiser | business execution | day-to-day order flow, milestones, documents |
| procurement_manager | procurement leadership | material risk, approvals, oversight |
| procurement | procurement execution | BOM/materials, purchasing, receiving |
| production_manager | production leadership | factory assignment, schedule, delay authority |
| production | production follow-up / QC | production progress, inspection, factory execution |
| qc | production quality | quality control, follow-up |
| finance | finance | budgets, receivables, payables, profit, reconciliation |
| logistics | logistics / warehouse | shipment, release, outbound, inventory handoff |
| admin_assistant | admin / operations support | cross-functional operational access |

## Current permission themes

### Broad visibility

- `admin`
- `finance`
- `admin_assistant`
- `production_manager`
- `sales_manager`
- `order_manager`
- `procurement_manager`

### Financial visibility

- `admin`
- `finance`
- `sales`
- `sales_manager`
- `order_manager`

### Delay approval

- `admin`
- `order_manager`
- `sales_manager`

### Price approval

- `admin`
- `sales_manager`

### Owner reassignment

- `admin`
- `production_manager`
- `sales_manager`
- `order_manager`

## Audit notes

- The runtime role layer contains fallback behavior and must be audited carefully for silent permission drift.
- The org docs and the runtime `roles.ts` file are not identical in wording; the audit must trace what the system actually enforces, not only what the org docs describe.
- This snapshot is a starting point for role / route / button reconciliation.
