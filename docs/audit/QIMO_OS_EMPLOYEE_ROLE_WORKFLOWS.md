# QIMO OS Employee Role Workflows

## Sales / Business Development

Customer/quote -> upload or manually enter PO -> review AI prefill -> obtain internal order number from Finance offline -> create Order -> complete PO handoff -> remain owner of customer-facing commitment and commercial revisions.

## Order execution / Merchandiser

Receive post-PO assignment -> verify order documents/SKU/packaging -> submit procurement verification -> coordinate samples and customer confirmations -> monitor production/QC/logistics milestones -> escalate exceptions. They must not silently change approved commercial/financial truth.

## Procurement

Receive approved BOM/material requirement -> review imported candidates -> source suppliers/quotes -> obtain procurement-manager and Finance gates -> issue approved purchase -> track required dates/receipts/shortage/substitution. No imported candidate automatically creates a PO.

## Production Supervisor

Review production intake -> assign eligible production follow-up -> oversee factory selection/material readiness/schedule -> approve production operational delay -> manage exception/overdue queues. Customer delivery commitment remains a business-manager decision.

## Production Follow-up

Accept assignment -> contact/select factory -> confirm schedule/material readiness -> record cutting/online actuals with inherited unit -> submit production delay when needed -> hand off to QC. Cannot approve own delay.

## QC

Receive inspection task only on valid production trigger -> conduct first-piece/in-line/final inspection -> record severity/evidence -> require corrective action/reinspection -> approve or hold release. QC cannot change customer price, quantity or financial data.

## Logistics

Receive QC-released shipment readiness -> validate packing/carton/SKU quantities -> book/ship partial or full batches -> store documents/tracking -> notify Finance milestones. Must not ship over approved quantity or bypass QC hold.

## Finance

Confirm internal order number/financial milestone -> review order baseline -> approve procurement financial gate/payment -> reconcile receipts/payments -> settle/profit/GL. AI is read-only recommendation/extraction; the authenticated Finance human is the write approver.

## Current operating gaps

- Finance internal-order-number issuance is offline and not an auditable workflow object.
- Production Supervisor workflow is deployed but still needs employee acceptance.
- QC lacks a proven complete task-driven workbench and end-to-end trigger test.
- Integration failures do not consistently enter a named employee-owned recovery queue.
