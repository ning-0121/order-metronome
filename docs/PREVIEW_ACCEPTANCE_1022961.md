# 1022961 Preview employee acceptance

> 本 Preview 与 Production 共用 Supabase。只允许在专门创建、名称含 `TEST / NOT A REAL ORDER` 的测试订单中操作；严禁使用订单 1022961 或真实客户文件。完成截图后删除测试附件和测试 BOM 行，且不要点击“提交采购”。

## 打开页面和测试文件

1. 打开当前 Preview，登录后进入专用人工测试订单。
2. 打开订单详情的「原辅料和包装」页签。
3. 测试文件位于本机 `/private/tmp/qimo-acceptance-1022961/`：
   - `TEST_NOT_REAL_SIZE_CHART.xlsx`
   - `TEST_NOT_REAL_SIZE_CHART_INVALID.xlsx`
   - `TEST_NOT_REAL_ACCESSORY_PROCUREMENT.xlsx`

Record each result as `PASS` or `FAIL` and attach a screenshot that contains the visible status/value but no secret or customer data.

| # | Employee step | Expected UI/value | Result | Screenshot evidence |
|---|---|---|---|---|
| 1 | 「原辅料和包装」→「技术部大货确认单」→「上传确认单」，上传人工中文名 JPG，再上传 PDF。 | 上传完成、中文显示名保留、按钮恢复为“上传确认单”。 | ☐ | 附件列表和成功状态。 |
| 2 | Open the artificial two-piece order with 7,700 sets and component consumptions 0.35 and 0.32. | Auto material total is `5,159 kg` before separately displayed loss; never `10,318 kg`. | ☐ | Both component inputs, set quantity and total. |
| 3 | Enter processing fee `42`. | Label reads `元/套 × 7,700 套`; total/formula is `¥323,400`. | ☐ | Processing input and formula. |
| 4 | Enter accessory budget `2`. | Label reads `元/套 × 7,700 套`; total is `¥15,400`. | ☐ | Accessory input and formula. |
| 5 | 「尺码表」→「上传尺码表」，选择 `TEST_NOT_REAL_SIZE_CHART.xlsx`，再点“查看并审核”。 | 显示“待复核 · 5 行”、工作表名和尺寸行；点击“确认通过”后显示“已审核”，不会自动应用生产规格。 | ☐ | 状态徽章、5 行预览和审核后状态。 |
| 6 | 再次上传同一个 `TEST_NOT_REAL_SIZE_CHART.xlsx`；随后上传 INVALID 文件。 | 重复文件明确拒绝且只有一个活动记录；INVALID 显示安全的解析失败原因，页面仍可操作。 | ☐ | 重复错误、单一记录及 FAILED 状态。 |
| 7 | 「+ 加原辅料」打开详情，填写规格、位置、详细位置说明、用量基准、样品编号并上传人工画稿；保存后重新编辑，再点“生成辅料单”。 | 所有字段重载后仍存在；导出表包含规格、位置详情、样品参考和中文用量基准。 | ☐ | 编辑详情和导出 Excel。 |
| 8 | 「辅料采购清单」→「上传」，选择 `TEST_NOT_REAL_ACCESSORY_PROCUREMENT.xlsx`。在“辅料导入候选审核”筛选状态、编辑一条、批准一条、排除一条。 | 候选行、缺失字段、精确匹配原因和源文件可见；刷新后状态保留；没有采购单自动生成。 | ☐ | 候选审核表及采购区没有新增采购单。 |

## Artificial fixture rules

- Mark every document `TEST / NOT A REAL ORDER`.
- Do not include real customer/supplier names, addresses, emails, telephone numbers, prices, bank information or order numbers.
- Use only an isolated staging/branch database; delete test records after screenshots.
- 当前没有隔离库时，只能使用专用测试订单；绝对不要打开或修改真实订单 1022961。
- 验收全过程不要点击“提交采购”“重新提交采购”或任何最终下单按钮。

## Failure capture

For a failure, capture the page, visible safe error category, timestamp and step number. Do not capture browser storage, request authorization headers, Supabase keys or complete internal payloads.
