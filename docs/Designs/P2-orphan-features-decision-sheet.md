# P2 孤儿功能去留决策单(2026-08-19)

来源:接收方可达性审计 P2。每项都是"当年有人要过的功能",去留由 CEO 逐项勾选。
**已带生产数据佐证**;「恢复成本」= 挂回入口的工作量,不含后续维护。

勾选说明:填「恢复 / 删除 / 保持关闭 / 待定」。

---

## A. 建议恢复(有活着的消费方在等它)

| # | 功能 | 现状与证据 | 恢复成本 | 建议 | 决策 |
|---|---|---|---|---|---|
| A1 | **报价基线录入**(QuoteBaselineTab + 3 action) | Tab 已从订单页拆除(注释"2026-07-08 弃用")。**但超基线拦截闸(bom.ts 提交采购的单耗超基线审批)至今在消费它的数据 —— 生产库基线 0 张,闸从未拦过任何东西,纯空转** | 挂回 tab 一行 + 验一遍流程,半天 | **恢复**(或明确废掉超基线闸,二选一,不能闸在录入口死) | ☐ |
| A2 | **采购对账 / 退货 / 付款申请**(ProcurementReconciliationPanel,25 handler + 9 action) | PO 详情页注释"保留未删,要恢复加回一行即可"。三张表全 0 行 = 从未用过。**「付款待回执」审批类别会恒 0,因为建付款申请的唯一入口就是这个孤儿面板** | — | **✅ 已定案:删面板、保付款通道**。CEO 2026-07-11 已判对账「没用」;对账走供应商台账/收货对账单页。付款待回执不靠周付款面板 —— PO 详情页「定金/月结」按钮(submitPurchaseDeposit)才是活进料口,直接进「待审批中心 · 付款待回执」。删面板 + 6 个对账退货专属 action + 2 个周付款 action,保 getOrCreateReconciliation/submitPurchaseDeposit | ✅ |
| A3 | **订单备注**(OrderNotesTab + 3 action) | 组件挂着但 `notes` 无 tab 按钮、全库无链接;表 0 行 | 导航数组加一项,10 分钟 | **恢复**(零成本;跨部门留言正是审计里缺的东西) | ☐ |

## B. 建议删除(有明确弃用证据或替代品)

| # | 功能 | 现状与证据 | 建议 | 决策 |
|---|---|---|---|---|
| B1 | 晨报卡(MorningBriefingCard + briefing action) | CEO 页注释"已下线 — 用户反馈太费钱用处不大" | **删** | ☐ |
| B2 | RoleTaskWorkbench | 测试脚本**断言它不出现**在生产页面 | **删** | ☐ |
| B3 | 成本控制 Tab(CostControlTab + 5 action) | 注释"2026-07-08 已弃用",tab body 已删只剩组件文件;成本真相已走 order_cost_baseline + profit.service | **删** | ☐ |
| B4 | 死 import ×4(CEO 页的 AgentSuggestionsPanel / DelayRequestActions;订单页的 RecalcButton / OrderScoreCard) | import 了从不渲染。延期审批和 Agent 建议在待审批中心都有活的出口(agent_actions 2927 行在产) | **清掉 import;组件本体**:DelayRequestActions/OrderScoreCard 删(有替代),AgentSuggestionCard 的执行/回滚能力若中心不覆盖则迁过去再删 | ☐ |
| B5 | 批量操作(BatchActions:批量分配跟单/批量催办) | 完全孤儿,且自带 3 个错误反馈缺陷(催办永远"成功 N/N") | **删**(真要批量,重写比修这个便宜) | ☐ |

## C. Feature-flag 关闭中(不是孤儿,是没开 —— 开不开是产品决策)

| # | 功能 | 开关 | 现状 | 建议 | 决策 |
|---|---|---|---|---|---|
| C1 | 装箱单(PackingTab + 5 action) | 无 flag,tab 被摘 | **表里有 6 行历史数据 = 死前有人真用过**;现出货单据走 shipment 流 | 若装箱职能已被出货单据覆盖 → 删;否则恢复 | ☐ |
| C2 | 订单决策面板(OrderDecisionPanel + 8 action) | ENGINE_BUSINESS_DECISION 未设置 | Executive OS 范畴 | 保持关闭,随 Executive OS 主线定 | ☐ |
| C3 | Executive 控制台(/executive + 12 action) | EXEC_OS_V1 未设置 + 零入站链接 | 同上(R1 已收尾) | 保持关闭 | ☐ |
| C4 | 根因面板(RootCausesPanel + 4 action) | flag 默认 false **且** tab key 不在白名单(双重恒假) | 逾期三桶模型已覆盖大半诉求 | 保持关闭;若永不开则按 B 处理 | ☐ |
| C5 | 风险订单列表(/risk-orders) | 入口卡片 2026-04-27 已下线 | 驾驶舱 B 区已覆盖 | **删** | ☐ |

## D. 顺手修(不用决策,下一批带走)

- 死链接:`?tab=email_diffs`(两处)→ 改指 email_center;任务卡 `?tab=finance` → 改指 financials
- 56 个仅被孤儿调用的 server action:**随宿主决策同进退**,单独列表见审计线②输出,不提前删

---

## 汇总建议(如果全按我的勾)

恢复 3(A1-A3,约 2 天)· 删除 7(B1-B5+C5,半天)· 保持关闭 3(C2-C4)· C1 待你判断装箱职能归属。
决策后一个 PR 执行 A/B/D,C 类不动代码。
