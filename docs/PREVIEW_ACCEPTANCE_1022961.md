# 1022961 Preview employee acceptance

> Database prerequisite: use an isolated Supabase staging/branch project. The current Vercel Preview points to Production Supabase, so database-dependent steps are **blocked** until that separation exists. Never use a real customer file.

Record each result as `PASS` or `FAIL` and attach a screenshot that contains the visible status/value but no secret or customer data.

| # | Employee step | Expected UI/value | Result | Screenshot evidence |
|---|---|---|---|---|
| 1 | In 原辅料和包装 → 技术部大货确认单, upload an artificial Chinese-named JPG, then a PDF. | Upload completes; original Chinese display name remains visible; button returns from 上传中. | ☐ | Attachment list and success state. |
| 2 | Open the artificial two-piece order with 7,700 sets and component consumptions 0.35 and 0.32. | Auto material total is `5,159 kg` before separately displayed loss; never `10,318 kg`. | ☐ | Both component inputs, set quantity and total. |
| 3 | Enter processing fee `42`. | Label reads `元/套 × 7,700 套`; total/formula is `¥323,400`. | ☐ | Processing input and formula. |
| 4 | Enter accessory budget `2`. | Label reads `元/套 × 7,700 套`; total is `¥15,400`. | ☐ | Accessory input and formula. |
| 5 | Upload artificial `YT-0707 S1567 大货尺寸表 26.7.4.xlsx`. | Status becomes `待复核`; parsed row count is non-zero. It is not automatically approved or applied. | ☐ | Filename, status badge and row count. |
| 6 | Upload the exact same XLSX again. | Upload is rejected as duplicate; the original active record remains unambiguous. | ☐ | Duplicate error and single active record. |
| 7 | Add a temporary accessory and enter specification, position description, set basis and artificial artwork. | Detail editor retains all values and preview/download works. Generated accessory sheet contains specification, position and artwork. | ☐ | Detail editor plus generated sheet. |
| 8 | Upload an artificial accessory procurement workbook. | Candidate rows appear for review with missing fields highlighted. No row is submitted to procurement automatically. Review states can be changed only by an authenticated reviewer. | ☐ | Candidate review list and procurement list showing no automatic submission. |

## Artificial fixture rules

- Mark every document `TEST / NOT A REAL ORDER`.
- Do not include real customer/supplier names, addresses, emails, telephone numbers, prices, bank information or order numbers.
- Use only an isolated staging/branch database; delete test records after screenshots.

## Failure capture

For a failure, capture the page, visible safe error category, timestamp and step number. Do not capture browser storage, request authorization headers, Supabase keys or complete internal payloads.
