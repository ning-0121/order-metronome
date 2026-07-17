# QIMO OS 企业级缺陷治理台账 — 2026-07

建立时间：2026-07-17  
当前分支：`fix/production-task-file-actions`  
当前 `origin/main`：`d642441ee18236bf855360f6f6cfd2f00c027bef`  
当前 Production deployment：`dpl_FbXQ2pSB78qFFLHiBUqNQH8bVF53`  
当前 Production Git SHA：`d642441ee18236bf855360f6f6cfd2f00c027bef`

## 0. 当前发布真相与仓库保护

- `origin/main` 与当前 Production 一致，均为 `d642441...`
- 当前 Production alias：`order.qimoactivewear.com`
- 当前 Production deployment id：`dpl_FbXQ2pSB78qFFLHiBUqNQH8bVF53`
- 当前 open PR（与本次问题直接相关者）：无
- 当前 open PR（仓库总体）：#24、#23、#22、#19、#18、#17、#15
- 当前工作区在切分前存在上一轮 hotfix 的未完成改动，已先以 stash 保留，避免污染 PR-A

## 1. 依赖与执行顺序

1. PR-A：生产任务单与附件阻断
2. PR-B：Quantity & Unit Engine
3. PR-C：Universal Size Chart Parser
4. PR-D：Material / Accessory Workflow
5. PR-E：PO / Delay / Dispatch Workflow
6. PR-F：Production Board Data Truth
7. PR-G：Metric Consistency

PR-A 必须先完成并验收，再允许下游问题进入实现阶段。

## 2. 问题台账

| Issue ID | 模块 | 严重等级 | 用户证据 | 当前 Production 行为 | 当前 main 行为 | 已存在分支/PR | 根因（当前审计结论） | 临时方案 | 永久方案 | 是否需要 migration | Preview | Production 状态 | 员工验收 | 关闭状态 |
|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 生产任务单下载 | P0 | “下载生产任务单无反应” | 线上已有生产任务单下载入口，但按钮/错误反馈链路在部分入口不够明确；需确认下载入口是否都具备 loading/错误回显 | `app/actions/manufacturing-order.ts` 已使用 `QIMO 生产任务单标准模板 V1.0` 生成 XLSX；`MoDownloadButton` 也调用同一 action | 相关历史：PR #25 已做模板导出；当前无单独 PR-A | 根因候选：下载入口分散，部分入口未统一错误反馈/下载触发；需把“生成失败/按钮恢复/文件下载”做成统一 helper 并补测试 | 先保留现有导出能力，给失败显式文案与按钮恢复 | 统一导出 helper、统一 download helper、统一错误态 | 否（纯前端/Action 整理） | 待建 | 未变 | 需员工确认点击后有下载与错误提示 | 未关闭 |
| A2 | 大货确认单上传 | P0 | “大货单耗确认单上传失败 / 中文文件名上传失败” | 当前入口为 `BulkConsumptionEditor` → `uploadTechConfirm`；已使用安全 object key | main 已有 `lib/storage/safe-object-key.ts` 与 `app/actions/tech-confirm.ts` | 无直接 PR；相关上传栈已存在 | 根因候选：入口级状态/反馈不统一，浏览器文件类型限制与用户实际文件类型不匹配时仅靠 alert；需确认是否发生 RLS/类型拦截或按钮状态未恢复 | 保留 `JPG/PNG/PDF` 白名单，失败显式返回 | 统一上传状态、错误提示、支持中文原名显示但存储 key 保持 ASCII | 否（现有 key 规则已足够） | 待建 | 未变 | 需员工确认可上传并可在附件区看到记录 | 未关闭 |
| A3 | 面料单价保存消失 | P1 | “面料单价保存后自动消失” | `ProcurementItemsTab` 编辑 `materials_bom.budget_unit_price`；保存后 reload 重新 hydrate | main 已有 `saveBomBudgetUnitPrice` / `listBomConsumptionLines` | 无直接 PR | 根因候选：保存链路与 hydrate 源不一致，或写入受角色/RLS/降级路径影响，刷新时回读不到同一真相；需要把保存返回值与刷新源对齐 | 先展示保存结果与持久化来源，避免“写了但看起来没保存” | 统一预算单价真相来源与刷新口径，增加保存后回读一致性测试 | 否（优先逻辑/读模型修正） | 待建 | 未变 | 需员工刷新后仍能看到同一值 | 未关闭 |
| B1 | 套装数量/单耗/加工费/辅料预算 | P1 | 套装翻倍、单耗精度偏差、加工费/辅料按件而非按套 | 现有代码在多个页面各自计算，存在口径散落风险 | main 中已有多处预算/核料/成本逻辑 | 相关长期分支存在，但无统一 engine | 根因：数量口径分散，页面直接算 `quantity * setMultiplier` 或把件数/套数混用 | 临时在单页补文案与校验 | 建立集中 quantity-engine 与 measurement-basis 统一合同 | 可能 | 待建 | 未变 | 需员工核对各页面口径一致 | 未关闭 |
| C1 | 尺码表解析 | P0 | 尺码表无法识别，提示不清 | main 已有尺码表上传与部分解析 | main 有 size chart / parse 相关代码 | 相关旧分支/文档已存在 | 根因：解析器分散、失败态缺少可操作提示 | 先显示可识别表头/缺失项 | 建立通用 parser + review flow | 可能 | 待建 | 未变 | 需员工可见“如何修复”而非仅失败 | 未关闭 |
| D1 | 辅料资料/采购清单导入 | P1 | 导入后仍需逐项重录 | main 已有辅料清单上传与候选审核 | main 具备 `accessory_purchase_list` 入口 | 相关采购/辅料工作流分支存在 | 根因：辅料字段和导入状态不统一，候选审核与最终采购真相未彻底贯通 | 继续沿用候选审核，不自动下单 | 统一 accessory import contract | 可能 | 待建 | 未变 | 需员工只处理差异与新项 | 未关闭 |
| E1 | 客户 PO 更换 | P1 | PO 修改后不能删换、历史不可追溯 | 现有订单页已有客户 PO 相关附件与解析快照，但版本化能力不完整 | main 已有 `order_attachments` 与 PO 解析链 | 当前 WIP 热修分支：`fix/po-delay-production-dispatch-workflows`（已 stash） | 根因：客户 PO 仍以附件为主，缺少版本状态与 active/superseded/withdrawn 语义 | 先保留旧 PO 与当前快照 | 新建 PO version model + dedicated panel | 可能（若现有表不足） | 待建 | 未变 | 需员工可上传新版、看历史、撤回错误版 | 未关闭 |
| E2 | 保交期延期 | P1 | 保交期只允许内部延期 1 天 | 当前 `hold_delivery` 逻辑已进入代码，但仍需按节点/缓冲验证 | main 中已有 `lib/domain/delay-rules.ts` / `components/DelayRequestForm.tsx` / `app/actions/delays.ts` | 当前 WIP 热修分支已处理一部分（已 stash） | 根因：内部节点延期与客户承诺交期混淆；旧 UI 文案/规则把“保交期”误解成 1 天上限 | 暂以风险提示代替硬拦 | internalDelayDays / customerDeliveryChangeDays 分离 | 否 | 待建 | 未变 | 需员工能提交 3 天内延期且客户交期不变 | 未关闭 |
| E3 | 生产主管派单 | P1 | 不能同时选工厂和生产跟单；未派单没有集中队列 | 现有 Production scheduling board 仍偏旧布局 | main 已有 `app/actions/production-scheduling.ts` / `components/production/SchedulingBoard.tsx` | 当前 WIP 热修分支已在起草（已 stash） | 根因：工厂派工与生产跟单是两个责任真相，但页面仍分散；未派单 predicate 未集中 | 先保留现有派工，补未派单汇总与 follow-up selector | 统一 dispatch truth + atomic assignment action | 否（优先读模型/动作） | 待建 | 未变 | 需员工可一次完成工厂+跟单指派 | 未关闭 |
| F1 | 排单卡片图片与颜色 | P1 | 排单卡片颜色和图片错误 | 旧排单/工厂看板仍可能用错图或错色 | main 已有生产/排产/订单图像与颜色多来源 | 相关生产看板分支存在 | 根因：图片优先级与颜色来源散落，仍可能读 AI/首附件/0 值 | 先在单页上修正优先级 | 统一图像与颜色 truth source | 否 | 待建 | 未变 | 需员工确认卡片图/色与确认数据一致 | 未关闭 |
| F2 | 工厂排产看板全为 0 | P1 | 在制订单全部显示 0 | 旧看板可能未抓到真实在制/派工 | main 有生产排产数据与 legacy factory assignment | 相关生产中心分支存在 | 根因：统计口径不统一，真实在制真相/旧字段/月份归属混用 | 先展示“无数据/未配置/真实 0”的区分 | 统一 factory schedule truth priority | 否 | 待建 | 未变 | 需员工与真实在制单比对一致 | 未关闭 |
| G1 | 数据分析/客户年度目标 | P1 | 总件数与年度目标件数口径不一致 | 线上指标存在混合口径风险 | main 已有 analytics 与 sales target service | 相关长期 audit 仍在 | 根因：时间范围/状态范围/套装乘数/出货重复等口径可能不一致 | 先改标签与 tooltip | 统一 metric service | 否 | 待建 | 未变 | 需员工确认同口径对账 | 未关闭 |

## 3. PR-A 现状结论

PR-A 只覆盖：

- 生产任务单下载链路
- 大货确认单上传链路
- 面料单价保存/刷新链路

PR-A 不处理：

- 数量引擎
- 尺码表通用解析
- 辅料导入总线
- PO / Delay / Dispatch 重构
- 排单图像/颜色真相
- 指标口径统一

## 4. 当前可见的代码证据

- 生产任务单导出：
  - `app/actions/manufacturing-order.ts`
  - `components/tabs/ManufacturingOrderTab.tsx`
  - `app/procurement/verify/[orderId]/MoDownloadButton.tsx`
  - 模板文件：`public/templates/QIMO_生产任务单标准模板_V1.0.xlsx`
- 大货确认单上传：
  - `components/BulkConsumptionEditor.tsx`
  - `app/actions/tech-confirm.ts`
  - `lib/storage/safe-object-key.ts`
- 面料单价保存：
  - `components/tabs/ProcurementItemsTab.tsx`
  - `app/actions/procurement-items.ts`
  - `saveBomBudgetUnitPrice(...)`
- 保交期 / 派单相关（当前已部分有代码，但不在 PR-A）：
  - `lib/domain/delay-rules.ts`
  - `components/DelayRequestForm.tsx`
  - `app/actions/delays.ts`
  - `app/actions/production-scheduling.ts`
  - `components/production/SchedulingBoard.tsx`

## 5. 生产任务单下载与模板真相

当前已确认：

- 模板文件真实存在，不是 Git LFS pointer
- 导出路径已从旧程序化重建切到模板驱动
- 下载入口分散，至少有两个前端按钮在触发同一导出动作

仍需在 PR-A 验证：

- 所有入口都能稳定显示 loading / error / finally 恢复
- 生成失败时不会表现为“无反应”
- 产物可重新打开，无修复警告

## 6. 关闭策略

| Issue ID | 关闭条件 |
|---|---|
| A1-A3 | 代码修复、测试、Preview、员工验收完成后关闭 |
| B1-C1 | 另起 PR-B/PR-C 后关闭 |
| D1 | 另起 PR-D 后关闭 |
| E1-E3 | 另起 PR-E 后关闭 |
| F1-F2 | 另起 PR-F 后关闭 |
| G1 | 另起 PR-G 后关闭 |

