# Order 1022961 / QM-20260703-021 workflow bug report

## Scope and safety

This change does not modify production data and does not deploy Production. Database changes are prepared as migration files only and have not been applied.

## 1. Bulk production confirmation upload

- Symptom: a Chinese-named JPG failed with `Invalid key`.
- Root cause: `uploadTechConfirm` copied the display filename, including Chinese characters, into the Supabase object key.
- Fix: the key is now server-generated as `{orderId}/tech-confirm/{uuid}.{validatedExtension}`. Only JPG, PNG and PDF are accepted; the original filename remains metadata. The UI resets its uploading state in `finally`.
- Tests: Chinese names, spaces, parentheses, duplicate display names, supported formats, invalid extension and path traversal.
- Residual risk: existing attachments are unchanged.

## 2. Two-piece set material requirement

- Old formula: `(0.35 + 0.32) kg/set × 7,700 sets × 2 pieces/set = 10,318 kg`.
- Root cause: both BOM display and procurement submission multiplied `order_line_items.qty_pcs` by `set_multiplier`, even though current persistence stores `qty_pcs` as set quantity and BOM consumption is defined per complete set.
- New formula: `Σ(component consumption per set) × order set quantity`. The example is `0.67 × 7,700 = 5,159 kg` before explicit loss.
- Explicit `PER_PIECE` remains available for a genuinely per-physical-piece line; only that basis converts sets to physical pieces.
- Precision: calculation uses fixed six-decimal integer scaling and does not round gross requirement to one decimal. Loss is calculated once and returned separately.
- The source spreadsheet total `5,177.3568 kg` implies a raw aggregate consumption of exactly `0.672384 kg/set`. The repository and supplied display values contain no source workbook/formula for this order, so the remaining `18.3568 kg` cannot be attributed safely. It is exactly the difference between the raw implied value and the displayed rounded `0.67` (`0.002384 × 7,700`). The fix preserves `0.672384` when imported; it does not invent an adjustment or loss factor.

## 3. Processing and accessory cost basis

- Root cause: the procurement UI hard-coded generic `元/件` wording and saved the accessory input with `per_piece`, while set orders use `orders.quantity` as sets.
- Fix: newly saved processing rows declare `cmt_basis=PER_SET`; processing and accessory UI now show `元/套 × 套数`, and accessory save uses `per_set`. Stored totals remain the downstream source of truth, so historical totals are not rewritten.
- Examples: `42 × 7,700 = 323,400 yuan`; `2 × 7,700 = 15,400 yuan`.
- Residual risk: a prepared migration adds a durable basis to each BOM line. It requires approval before application. Historical records remain untouched and need an explicit review/backfill decision.

## 4. Size chart recognition

- Root cause: upload only created `order_attachments(file_type='size_chart')`; no parser was called, no status existed and duplicates were allowed. Claude availability is unrelated.
- Fix: XLSX upload now runs deterministic parsing across worksheets, detects measurement headers and size columns, hashes the file for duplicate detection, and records `NEEDS_REVIEW` or an actionable `FAILED` status. Parsed measurements are never automatically applied.
- Tests: an artificial `YT-0707 S1567 大货尺寸表 26.7.4.xlsx` layout and unsupported-layout failure.
- Migration: `20260715_size_chart_import_status.sql` is required and has not been applied. Until approved, the action fails closed with a migration-required message rather than claiming recognition.

## 5. Accessory fields and generated sheet

- Current equivalents already exist: code, name, type, placement, color, spec, unit, unit consumption, total quantity, supplier, remarks, special requirements, two image slots and multiple file attachments. The generated accessory sheet already contains artwork, position image/text, specification, remarks, factory price and purchase price columns.
- Gap: durable `consumption_basis`, `sample_reference`, `position_description`, `supplier_quote`, `factory_quote` and `purchase_price` fields are absent.
- Prepared fix: `20260715_accessory_workflow_fields.sql` adds the missing optional fields without invalidating existing rows. It is not applied and UI persistence is intentionally not enabled before schema approval.
- Residual risk: current client-side accessory uploads use generated ASCII keys and retain the display name, but the public storage bucket policy should receive a separate security review.

## 6. Procurement/accessory document import

- Current behavior: `accessory_purchase_list` is stored and shared only; users must still create or import BOM lines separately.
- Root cause: there is no extraction, matching or review persistence layer.
- Prepared model: the migration defines auditable candidates with `SOURCE_IMPORTED`, `MATCHED_TO_EXISTING`, `NEW_ACCESSORY`, `NEEDS_REVIEW`, `APPROVED`, and `EXCLUDED`, retaining source, extracted and approved values.
- Safety rule: no candidate automatically creates purchasing records or issues a PO. Implementing the parser/review UI is blocked on migration approval; a supplier quotation without requirement fields must remain `NEEDS_REVIEW` and disclose missing fields.

## Files and verification

Targeted fixed-decimal, upload-key and size-chart parser tests pass. Existing MRP tests pass. Provider boundary gate passes with the pre-existing 18 audited legacy bypasses. Next production build completes 95/95 routes. Repository-wide lint has a pre-existing backlog of `no-explicit-any` violations; changed pure modules are covered by typechecked build and targeted tests.
