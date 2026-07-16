# QIMO OS V2 Information Architecture

This document defines the canonical UI structure for QIMO OS V2.

The operating model is fixed:

- Dashboard
- Workbench
- Detail

Employees should land on a dashboard first. Tables are execution surfaces, not homepages.

## 1. System Boundary

### Core execution chain

1. 订单中心
2. 采购中心
3. 生产中心
4. 物流中心

### System Portal

The system portal is the only place where cross-system entry appears. It can show:

- company overview;
- personal mission;
- approvals;
- risks;
- notifications;
- ARAOS entry;
- Finance OS entry.

### External systems

ARAOS and Finance OS are not part of the core execution sequence. They are linked from the portal only.

## 2. Page Hierarchy

Level 1:

- Portal / Module Center

Level 2:

- Workbench / List

Level 3:

- Detail / Task workspace

Deeper navigation should be avoided unless it represents a true object boundary.

## 3. Canonical Page Archetypes

### System Portal

Order:

1. Header
2. Personal summary
3. Company KPI
4. Cross-module workflow overview
5. Today tasks
6. Approvals
7. Risks
8. AI suggestions
9. QIMO module entries
10. External systems

### Module Center

Order:

1. Header
2. Quick entry row
3. KPI cards
4. Stage overview
5. Today tasks
6. Collaboration / approval
7. Risks
8. Collapsed detailed list

### Workbench

Order:

1. Title and scope
2. Queue tabs
3. Filters
4. Saved views
5. Compact table / list
6. Bulk actions
7. Detail drawer or detail route

### Detail Workspace

Order:

1. Sticky identity summary
2. Current stage
3. Current owner
4. Next action
5. Risk summary
6. Contextual actions
7. Tabs / sections
8. Collapsed history and audit trail

### Form

Order:

1. Object summary
2. Grouped fields
3. Inline validation
4. Consequence explanation
5. Sticky submit area if long
6. Safe draft behavior

### Approval

Order:

1. Requester
2. Current value
3. Proposed value
4. Business impact
5. Evidence
6. Required role
7. Approve / reject
8. Reason

### Decision Center

Order:

1. Pending approvals
2. Conflicts
3. Cross-domain exceptions
4. Risk interventions
5. Owner
6. SLA
7. Severity
8. Next action

## 4. Module Definitions

### 订单中心

- Purpose: convert confirmed commercial intent into executable orders.
- Start event: confirmed PO or approved order intake.
- End event: order handed off to procurement / production / logistics as appropriate.
- Primary owner: Business Execution.
- Key decisions: order validation, customer confirmation, order changes, shipment readiness.
- Key exceptions: missing PO data, customer mismatch, lifecycle breaks, overdue commitments.
- Key workbenches: order list, order detail, intake form.
- KPI summary: PO confirmed, to be created, in execution, ready to ship, overdue, risk orders.
- Approval summary: order changes, deadline changes, customer exceptions.
- Risk summary: missing data, overdue, blocked, split-order anomalies.
- Quick entries: new order, workbench, missing info, risk orders.

### 采购中心

- Purpose: convert order demand into controlled procurement execution.
- Start event: material demand or confirmed procurement requirement.
- End event: materials received and accepted, or risks escalated.
- Primary owner: Procurement.
- Key decisions: supplier selection, PO issuance, receiving acceptance, shortage handling.
- Key exceptions: missing BOM, shortage, supplier delay, price anomaly, quality reject.
- Key workbenches: procurement queue, PO archive, receiving list, ledger.
- KPI summary: to confirm, to order, in transit, received today, shortage, risk.
- Approval summary: purchase approval, substitute approval, price approval.
- Risk summary: shortage, delay, receive mismatch, quality reject.
- Quick entries: material confirmation, purchase order, receipt, supplier management.

### 生产中心

- Purpose: manage factory schedule, production execution, and progress control.
- Start event: production-ready demand with material readiness.
- End event: shipped or completed production execution.
- Primary owner: Production Manager.
- Key decisions: factory assignment, schedule, progress intervention, quality escalation.
- Key exceptions: capacity conflict, delay risk, QC risk, blocked orders.
- Key workbenches: schedule workbench, factory schedule, progress entry, risk handling.
- KPI summary: new orders awaiting procurement, materials in transit, ready to schedule, in production, ready to ship, risk orders.
- Approval summary: schedule changes, delay approval, factory reassignment.
- Risk summary: overdue, stalled, material shortage, QC risk.
- Quick entries: scheduling workbench, factory board, progress entry, risk orders.

### 物流中心

- Purpose: manage shipment readiness, booking, documents, and outbound execution.
- Start event: shipment-ready order.
- End event: order shipped / delivered / completed logistics handoff.
- Primary owner: Logistics / Warehouse.
- Key decisions: booking, release, document readiness, outbound exception handling.
- Key exceptions: missing documents, booking issues, blocked shipment, deadline risk.
- Key workbenches: shipment queue, outbound detail, document prep, exception handling.
- KPI summary: to release, to book, to pack, to ship, shipped, risk.
- Approval summary: release approvals, shipment exceptions.
- Risk summary: blocked outbound, document gap, deadline risk.
- Quick entries: pending shipment, booking, documents, exception handling.

## 5. System Portal Contract

The portal should answer four questions immediately:

- What matters today?
- What needs approval?
- What does AI recommend?
- Which workbench should I enter next?

The portal must not become a table of every operational record.

## 6. Design Principles

- Summary first, execution second, detail last.
- One object, one next action.
- Collapsed by default for large datasets.
- Role-aware action visibility.
- External systems only in the portal.
- No nested navigation duplication.
- Use progressive disclosure for lists and history.

