# 接收方可达性审计(2026-08-19)

**母题**:发起方视角完整、接收方视角没人验。一周内 6 个实例(PO 审批、补采审批、共享文件、
UnblockButton、拦截理由在一屏外、1022919 出货死胡同)后,CEO 拍板做一次全量只读审计。
四条线并行扫码 + 生产库实测。**本审计只读;已顺手修掉的标 ✅。**

## 判定基准(生产库实测,非仅读策略文件)

用临时 procurement 测试账号(真实 session,测完即删)逐表探测:

| 表 | 采购员实测 | 结论 |
|---|---|---|
| orders / order_logs / milestone_logs / order_line_items | 全量可见 | **2024 遗留宽策略仍活着**(migrations 里从未被 DROP) |
| milestones / delay_requests / order_attachments / order_cost_baseline / size_chart_imports / materials_bom / procurement_items / order_financials | **0 行** | 严格 RLS 生效;session 读 = 静默清零 |
| procurement_line_items | 报错拒绝 | 策略引用异常 |

**结构性根因**:`user_can_access_order` = 创建人/负责人/管理层,**没有"被指派节点的人"分支**,
且「采购侧旁路」策略(user_is_procurement_side)在生产库**并未生效**。App 层到处按
"被指派可见/采购可见"写权限判断,DB 层不认 → 各部门 session 读到的是空。
今天各页面"能用",大多是因为读路径已被逐个改成 service-role,或测试者是 admin。

## 按影响排序的修复清单

### P0 — 正在造成业务损失/僵局

1. ✅ 出货放行死胡同(1022919,25 张在办单同病)——已修(#99)
2. ✅ 超预算审批无接收面(1022977 两条挂一周)——已进待审批中心(#99)
3. **核料页预算对照/人工合并对采购员失效**(`order_cost_baseline` 严格 + session 读):
   预算列空、采购手动合并的料每次归并又裂开、来源明细丢款号。修法=这三处读走 svc(procurement-items.ts:356/815/1225)
4. **生产任务单对采购/生产/QC 缺段**:尺码表 sheet 空(size_chart_imports)、
   面辅料三段空(materials_bom 对 production/qc)。manufacturing-order.ts:68/269 改 svc
5. **辅料导入候选对跟单/采购全链路失效**(accessory_import_candidates T1):
   列表空/批量通过 0 条/导入被拒。accessory-import.ts:43/50/93
6. **待采购队列永不出队 + 订单号整列空白**(milestones/orders 嵌套 join 对采购员):
   procurement.ts:1312/1324

### P1 — 审批/通知结构洞(模式与已修四类相同)

7. `budget_approvals` 通知绕过统一入口且写错字段(`is_read` vs 全站读 `status`)+ insert 不查 error —— **通知从未送达过**
8. `order_purpose_change_requests` / `order_documents pending_review`:零站内通知,仅订单页横幅
9. 付款申请(procurement_payment_requests / supplier_ledger_payables submitted):站内无任何列表
10. `integration_outbox status='dead'`:通知让 admin"去查表",无工作台页
11. 待审批中心本身不在 Navbar,只能从工作台卡片进
12. 通知未读率 42%(3924/9389)——铃铛作为唯一接收面已失效的量化证据

### P2 — 孤儿功能(做了但没人能用)

13. 完全孤儿交互组件 7:PackingTab(装箱单全套)、CostControlTab、QuoteBaselineTab、
    ProcurementReconciliationPanel(采购对账/退货/付款 25 个 handler)、BatchActions、
    MorningBriefingCard(已明确下线)、RoleTaskWorkbench
14. 死 import 4(ceo/orders 页 import 不渲染):AgentSuggestionsPanel、DelayRequestActions、RecalcButton、OrderScoreCard
15. 挂了但无入口:OrderNotesTab、ProductVariantPicker(?tab 不在导航);RootCausesPanel 双重恒假
16. 死链接:`?tab=email_diffs`、任务卡 `?tab=finance` → 静默落基本信息页
17. 由此连带:56 个 server action 仅被孤儿组件调用(见扫描输出,决定去留前别删)

### P3 — 错误反馈不可见("点了没反应"家族)

18. 弹窗内错误渲染在遮罩层背后(核料页尾料归库/归并计划)——错误 100% 不可见
19. 完全丢弃 action 错误约 20 处(QC 通过/不通过、BOM 交样、删共享文件、排产属性、
    通知已读、批量催办永远"成功 N/N"等,详见扫描输出)
20. ShipmentTab 全部按钮的错误渲染在 223-281 行外
21. MilestoneActions「未通过/需返样」直写 supabase 不读 error(RLS 拒绝=静默 no-op)
22. alert() 130+ 处(可达但体验差,最低优先)

## 建议的推进方式

- P0 的 3-6 是同一个修法(session→svc,前置代码鉴权),一个 PR 可清完
- P1 的 7 是一行字段名 + 补 error 检查;8-10 逐个进待审批中心(模式已成熟)
- P2 先决策去留(每个孤儿都是当年有人要过的功能),留的挂回入口、不留的删码
- P3 建议统一出一个 `useActionFeedback` 钩子替换散装 setMsg/alert,逐组件迁移
- **流程约束(建议进 DoD)**:新增"XX 待审批"状态必须同 PR 登记待审批中心类别;
  新增跨部门读必须走 repo+svc;跨部门功能验收必须用接收方角色账号过一遍

## 原始扫描输出

四线完整结果(含全部文件:行号)存于本次会话记录;后续修复 PR 逐条引用。
