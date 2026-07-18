# PR #31 Regression Download Review

Scope: verify the download engine change against all major download entry points.

## Table

| Feature | Current implementation | Uses new helper? | Broken? | Need migration? |
|---|---|---:|---:|---:|
| Production Task | `app/procurement/verify/[orderId]/MoDownloadButton.tsx` + `components/tabs/ManufacturingOrderTab.tsx` | Yes | No | No |
| Quotation PDF / export | `app/quoter/[id]/QuoteDetailClient.tsx` | No | No | Yes, later |
| BOM Export | `components/tabs/BomTab.tsx` | No | No | Yes, later |
| Purchase Export | `app/procurement/po/[id]/PurchaseOrderDetailClient.tsx` | No | No | Yes, later |
| Invoice / Packing List / CI / Statement | `components/tabs/ShippingDocsSection.tsx` + server actions in `app/actions/shipping-docs.ts` | No | No | Optional later |
| Customer PO attachment download | `app/orders/[id]/page.tsx` direct `<a href download>` | No | No | No |
| Attachment preview/open | `components/PackingFilesSection.tsx` `window.open()` | No | No | No |
| Procurement ledger export | `components/procurement/ProcurementLedgerExport.tsx` | No | No | Yes, later |
| Supplier ledger export | `app/procurement/ledger/SupplierLedgerClient.tsx` | No | No | Yes, later |
| Goods receipts export | `app/procurement/ledger/GoodsReceiptsPanel.tsx` | No | No | Yes, later |
| Receipt statement export | `app/procurement/receipts/ReceiptStatementClient.tsx` | No | No | Yes, later |
| Production reconcile export | `app/production/ReconcileExportButton.tsx` | No | No | Yes, later |
| Export sample request | `components/ExportSampleRequestButton.tsx` | No | No | Yes, later |
| Export preview | `components/ExportPreviewButton.tsx` | No | No | Yes, later |
| Factory schedule export | `components/production/FactoryScheduleBoard.tsx` | No | No | Yes, later |

## Notes

- The new helper is already correctly used on the production-task export paths.
- The remaining blob-based exports are legacy implementations, but they are not broken by this PR.
- Direct URL attachment downloads should stay separate from blob exports.
- `window.open()` preview/open behavior is not a download problem and should not be forced into the helper.

## Migration recommendation

Migrate later, in a separate consolidation PR, in this order:

1. remaining blob-based Excel exports
2. then any other generated-download patterns that still duplicate anchor creation
3. keep signed URL attachment downloads and preview/open behavior unchanged

