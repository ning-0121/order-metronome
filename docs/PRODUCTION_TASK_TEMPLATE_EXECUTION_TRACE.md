# Production Task Template Execution Trace

## Current employee flow

`components/tabs/ManufacturingOrderTab.tsx` renders the Production Task page actions. The employee opens Preview and then selects **下载生产任务单**. The client calls the `generateProductionOrderSheet(orderId)` server action, decodes its base64 XLSX response, and downloads the returned safe filename.

The preview now identifies the approved source as **QIMO 生产任务单标准模板 V1.0**. It remains an operational data preview; the downloaded workbook is the print-fidelity authority.

## Server and generator trace

1. UI trigger: `components/tabs/ManufacturingOrderTab.tsx`
2. Server action: `app/actions/manufacturing-order.ts::generateProductionOrderSheet`
3. compatibility/data adapter: `app/actions/manufacturing-order.ts::buildExactProductionTaskWorkbook`
4. centralized cell contract: `lib/exports/production-task-template-map.ts`
5. master-backed generator: `lib/exports/production-task-template.ts`
6. template load: `public/templates/QIMO_生产任务单标准模板_V1.0.xlsx`
7. ExcelJS serializes the imported workbook; the action returns base64 plus `{internalOrderNumber}_生产任务单_{styleNumber}.xlsx` after unsafe-character replacement.

The combined `generateManufacturingOrderSheet` action uses the same exact master path. The independently timed auxiliary-material download (`generateTrimSheet`) remains on its existing generator because it is a separate employee artifact and is not the CEO master workbook replacement target.

## Root cause before replacement

The former production-order code created a new `ExcelJS.Workbook`, added dynamically named worksheets, and programmatically recreated columns, row heights, merges, fonts, borders, alignment, image placement, and print configuration. It also used shrink-to-fit and variable row-height estimates. Consequently, the export was an approximate reconstruction and could not be guaranteed identical to the approved workbook.

## Approved data sources

The server adapter reads only persisted business truth:

- `orders`: internal/order number, customer, dates, description, total quantity, size order and packaging metadata;
- `order_line_items`: approved style/color/size quantities and carton counts;
- `materials_bom`: approved fabric/accessory descriptions, consumption value, unit and basis;
- `manufacturing_orders`: confirmed factory requirements and risk notes;
- `profiles`: existing signature/audit name lookup in the legacy auxiliary path.

It does not call AI, parse a PO, or read a PO snapshot. Missing historical values become blank. Quantities are summed once from approved line-item `qty_pcs`; order quantity is only a fallback, preventing a set multiplier from being applied twice.

## Workbook structure

The imported master sheets remain first and unchanged in name:

- `LU21-SET 上衣` (master print area `A1:L25`, A4 portrait, 50%, horizontally centered)
- `LU21-SET尺寸表` (master print configuration A4 landscape, 90%)

ExcelJS reports an additional styled row in the second worksheet model (`A1:J14`) although the CEO specification describes the business used range as `A1:J13`. The implementation does not delete or reinterpret that master-owned row.

For base orders (up to four color rows and three visible sizes), no worksheet, row, column, merge, dimension, or print property is added or changed. For more colors or sizes, the main two sheets remain intact and a `款色尺码明细附页` is added using copied master header/detail styles and widths. This avoids squeezing columns, overwriting the customer-packaging merge, changing font size, or shifting fixed sections. The explicit quantity-basis column distinguishes 件/套/组件.

## Field mapping and known blank behavior

Central mappings live in `lib/exports/production-task-template-map.ts`.

| Business field | Template target |
|---|---|
| Internal order + customer | `D2` |
| Order date | `J2` |
| Product / composition | `D3` / `J3` |
| Delivery / fabric weight | `D4` / `J4` |
| Total quantity | `D5` |
| Style, color, cartons, quantity, sizes | rows `7:10`, columns `A:G` |
| Customer packaging | `H7:J10` master merge |
| Totals | `C11`, `D11` |
| Fabric consumption/value/unit/basis | `A12:L12` master merge |
| Sampling | `B14`, `D14`, `B15`, `D15` |
| Accessories and requirements | `B16:B23` (master merged through `L`) |
| Receiver/time | `B25`, `J25` |
| Size title/headers/measurements | size sheet rows `1`, `3:13` |

No approved sampling or size-chart record is currently returned by `getManufacturingOrder`; those mapped cells are therefore deliberately blank rather than populated from AI or an attachment. The centralized model accepts reviewed size-chart and sampling values when their approved repository adapter is added.

## Fidelity controls

`lib/exports/production-task-style-manifest.ts` normalizes sheet names, used ranges, merges, every column width, every row height, font, fill, border, alignment, wrap setting, number format, protection, and page setup. `scripts/test-production-task-template.ts` compares the generated base workbook with the master, locks fixed wording/rich warnings, checks repeat determinism, overflow, missing-template fail-closed behavior, safe filenames, and reopens the serialized XLSX to detect structural corruption.

Six regression fixtures cover four colors/S-M-L, a two-piece set, color overflow, size overflow, missing optional values, and long Chinese packaging instructions. The repository has no installed LibreOffice/Excel renderer or established pixel-diff harness, so these fixtures currently perform stable workbook layout/style manifest acceptance rather than raster pixel comparison.
