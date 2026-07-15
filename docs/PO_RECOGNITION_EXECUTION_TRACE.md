# Production PO Recognition Execution Trace

## New-order upload path

```text
Upload
components/order/LegacyOrderForm.tsx::handlePOFileChange
  customer PO PDF / image / Excel selected in the order form
↓
Route
Next.js Server Action transport (there is no public PO-recognition API route)
↓
Action
app/actions/po-parser.ts::parsePO
↓
Parser
image → base64 ImageInput
PDF → base64 FileInput
Excel → excelToText → prompt text
↓
Runtime
qimoAI.generateObject
scene=order.po.parse
logicalModel=qimo.structured-extraction
schema=poParsedSchema
↓
Provider
Capability Router → configured Provider adapter → actual provider/model returned in metadata
↓
Response
parsePO returns the existing `{ ok, data, error, draftId }` contract;
validated output is saved as a recoverable draft and, when an order exists, a frozen snapshot
↓
UI
LegacyOrderForm merges recognized PO fields without overwriting manually entered values;
LineItemMatrixEditor receives styles/colors/sizes; failures remain visible and do not create false data
```

## Submit-time verification branch

```text
Upload selection retained by LegacyOrderForm
↓
verifyThreeDocuments (when at least two quote/PO documents exist)
or verifyPOAgainstOrder (fallback when initial PO parsing did not produce a result)
↓
app/actions/po-verify.ts::extractDocument
↓
PDF / image / Excel normalization
↓
qimoAI.generateObject using qimo.structured-extraction
↓
configured Provider adapter and strict schema validation
↓
existing POVerifyResult / ThreeDocVerifyResult contracts
↓
LegacyOrderForm difference, risk, and CEO price-approval dialogs
```

## Existing-order production-sheet path

`OrderTimeline → POParserModal → parsePO → qimoAI → provider → editable preview → generateProductionOrder → download UI` uses the same Runtime-backed parser.

## Claude dependency marks

- `app/actions/po-parser.ts`: no direct Claude dependency; already Runtime-backed before this change.
- `app/actions/po-verify.ts::verifyPOAgainstOrder`: **legacy Claude dependency removed**.
- `app/actions/po-verify.ts::verifyThreeDocuments`: **legacy Claude dependency removed**. Each supplied document is extracted through Runtime, then comparisons and the price gate are deterministic business logic.
- `components/order/LegacyOrderForm.tsx`, `LineItemMatrixEditor.tsx`, `POParserModal.tsx`, and `OrderTimeline.tsx`: no Provider SDK or Provider key access.
- `app/actions/po-extract.ts`: still contains Claude, but no current UI, Route, or Action calls `extractPOFromAttachment`; it is outside the traced production upload execution path and was intentionally not changed.
- `app/actions/documents.ts`: still contains Claude for AI document generation, downstream of stored PO data and outside PO recognition; intentionally not changed.
- `app/actions/photo-parser.ts` and `app/actions/production-progress.ts`: production-photo OCR paths, not customer PO upload; intentionally not changed.
