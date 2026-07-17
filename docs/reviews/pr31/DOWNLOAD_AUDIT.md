# PR #31 Download Engine Audit

Scope: repository-wide audit of current download entry points after introducing `lib/browser/download.ts`.

## Current implementation

The new shared helper is:

- `lib/browser/download.ts`
  - `base64ToBlob()`
  - `triggerBlobDownload()`

It standardizes the common browser path:

1. base64 → `Blob`
2. `URL.createObjectURL()`
3. hidden `<a download>`
4. click
5. revoke object URL

It is already used by:

- `app/procurement/verify/[orderId]/MoDownloadButton.tsx`
- `components/tabs/ManufacturingOrderTab.tsx`

## Repository-wide audit

I searched for:

- `createElement("a")`
- `download=`
- `.click()`
- `Blob` download implementations
- `window.open`
- `FileSaver` / `saveAs`

### Download / export entry points found

| File | Current implementation | Notes |
|---|---|---|
| `app/procurement/verify/[orderId]/MoDownloadButton.tsx` | Uses `base64ToBlob()` + `triggerBlobDownload()` | Migrated to shared helper |
| `components/tabs/ManufacturingOrderTab.tsx` | Uses `base64ToBlob()` + `triggerBlobDownload()` | Migrated to shared helper |
| `components/ExportSampleRequestButton.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/ExportPreviewButton.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/production/FactoryScheduleBoard.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/procurement/ProcurementLedgerExport.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/tabs/ProcurementTab.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/tabs/BomTab.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/tabs/PITab.tsx` | Inline `Blob` + `a.click()` | Duplicate browser download logic |
| `components/tabs/ShippingDocsSection.tsx` | Local `downloadBase64()` helper with inline `Blob` + `a.click()` | Similar pattern; not yet centralized |
| `components/POParserModal.tsx` | Native `<a download>` in a generated-file step | Not a blob helper candidate; final download link only |
| `app/quoter/[id]/QuoteDetailClient.tsx` | Inline `Blob` + `a.click()` | Quotation export path |
| `app/procurement/po/[id]/PurchaseOrderDetailClient.tsx` | Inline `Blob` + `a.click()` | Purchase order export path |
| `app/procurement/receipts/ReceiptStatementClient.tsx` | Inline `Blob` + `a.click()` | Statement export path |
| `app/procurement/ledger/GoodsReceiptsPanel.tsx` | Inline `Blob` + `a.click()` | Ledger export path |
| `app/procurement/ledger/SupplierLedgerClient.tsx` | Inline `Blob` + `a.click()` | Ledger export path |
| `app/production/ReconcileExportButton.tsx` | Inline `Blob` + `a.click()` | Production reconciliation export |
| `app/orders/[id]/page.tsx` | Direct `<a href download>` attachment download | This is a signed/file URL download, not a generated blob export |
| `components/PackingFilesSection.tsx` | `window.open(url, '_blank', 'noopener,noreferrer')` | Preview/open action, not a blob download |

## Can migrate?

Yes, most blob-based export buttons can migrate to the shared helper without changing business behavior.

Good candidates:

- `components/ExportSampleRequestButton.tsx`
- `components/ExportPreviewButton.tsx`
- `components/production/FactoryScheduleBoard.tsx`
- `components/procurement/ProcurementLedgerExport.tsx`
- `components/tabs/ProcurementTab.tsx`
- `components/tabs/BomTab.tsx`
- `components/tabs/PITab.tsx`
- `app/quoter/[id]/QuoteDetailClient.tsx`
- `app/procurement/po/[id]/PurchaseOrderDetailClient.tsx`
- `app/procurement/receipts/ReceiptStatementClient.tsx`
- `app/procurement/ledger/GoodsReceiptsPanel.tsx`
- `app/procurement/ledger/SupplierLedgerClient.tsx`
- `app/production/ReconcileExportButton.tsx`

Lower priority / keep as-is:

- `app/orders/[id]/page.tsx` attachment downloads
- `components/PackingFilesSection.tsx` preview/open-in-new-tab behavior
- `components/tabs/ShippingDocsSection.tsx` if the current local helper is intentionally kept for that single composite workflow

## Risk

Main risks in the duplicated implementations:

- inconsistent filename handling
- missing `aria-busy` / loading feedback
- object URL leaks or missing revoke calls
- repeated error handling differences
- future divergence across exports

The new helper reduces those risks for the paths already migrated.

## Should migrate now?

Not for the whole repository in this PR.

Reason:

- PR #31 is scoped to production task file actions and budget verification UX.
- The shared helper has already been adopted by the two highest-value touched paths.
- A repository-wide export normalization would be a separate consolidation PR.

## Should migrate later?

Yes.

Recommended follow-up order:

1. all blob-based Excel exports
2. then other browser-generated downloads if they still need unification
3. keep signed URL downloads and open-in-new-tab previews on their own paths

## Conclusion

The download engine direction is correct.

Current state:

- the helper is valid and reusable
- the PR already migrated the production task download flow
- the remaining duplicate download logic is legacy debt, not a blocker for this PR
