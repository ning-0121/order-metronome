# R1-C Mutation Map(只读设计,2026-08-08)

> 逐条实读代码后的现状写入链。风险栏 = half-success 具体形态。
> 客户端:S=session(受 RLS)/ SR=service-role。

## A. money-critical

### A1 改单批准 `order-amendments.ts approveOrderAmendment`
- 现状链:门禁 → **amendments.status='approved'(S,裸写)** → orders.update(S,裸写,无 select)→ executeSideEffects → fresh read → syncOrderToFinance → 通知提交人 → return success
- 权限:代码层 admin/order_manager/sales_manager + finance 字段加验;RLS:orders UPDATE 仅创建人/admin(2024 老策略)
- 风险:①先标 approved 后改 orders,orders 写失败(RLS 0 行无 error)= **幽灵批准**,财务同步旧值;②审批人非 admin 非创建人时 orders 写必被 RLS 滤成 0 行
- 目标链:门禁 → **orders 写(SR+断言+回读) → amendments approved(断言,pending 谓词防并发) → 副作用 → 财务同步(verified fresh) → 通知**

### A2 价格审批 `price-approvals.ts:125`
- 现状:代码允许 sales_manager;update(S) 无 .select() → RLS 只认 admin ⇒ 经理批准 UI 成功库里 pending
- 目标:代码鉴权(现有)→ SR 写 + 断言 1 行(策略 B:command-based,权限在代码层,明确记录)

### A3 财务写入组 `cost-control.ts:273 等`
- order_financials 售价 upsert / purchase_orders.total_amount 回写 / order_commissions upsert,全裸写
- 目标:safeMutation + error/行数断言,失败向上返回(不能静默错账)

## B. delivery-critical

### B1 延期批准 `delays.ts approveDelayRequestCore → recalculateSchedule:993`
- 现状链:delay_requests='approved'(SR,有查 error)→ 发"已通过"通知 → recalcSchedule:**orders 锚点写(SR,裸写)** → milestones 逐条重算(有查 error)
- 风险:锚点写失败 → 头旧节点新错位;通知已发
- 目标:锚点写断言;失败 → 记 milestone_logs 'delay_anchor_write_failed' + **禁止节点重算** + 向上返回 error

### B2 延期链推进 `delays.ts confirmDelayStep:491-527 + 批量 1542`
- 现状:5 处 SR 裸写(current_step/approval_chain/reschedule_mode)→ return ok:true + 通知下一级
- 目标:每处断言 1 行;失败不通知、不 ok

### B3 延期驳回 `delays.ts:865`
- 现状:update(S).select().single() → 经理(非 admin 非链首)被 RLS 滤 0 行 → PGRST116 晦涩报错,**只有 Alex 驳回得动**
- 目标:代码鉴权已有(canActOnDeferralStep)→ SR 写 + 断言

### B4 生命周期:拒绝导入 `orders.ts:2105` / 确认已出货 `confirm-shipped.ts:54`
- 现状:cancelled 写(S,裸)→ 发"已拒绝"通知 → return 成功;completed 写(SR,裸)
- 目标:SR + 断言 → 才通知

## C. permission-sensitive

### C1 逾期任务清理 `milestones.ts:901`
- 现状:daily_tasks.update(S) —— 完成人≠被派人时 RLS 滤 0 行 ⇒ my-today 僵尸卡
- 目标:SR + 断言(0 行=无任务,合法)

### C2 跨用户经营写 `inspection-waiver.ts / sample-fee.ts / overdue-triage 转派 / 分批标记`
- 现状:orders.update(S) 打在别人建的单上 → RLS 滤 0 行静默
- 目标:**策略 B(command-based)**:代码鉴权(各处已有 requireRole)→ SR 写 + safeMutation 断言。
  明确记录:选 B 因高价值经营动作需要即刻可用且审计上下文在代码层;RLS 全面重写留给 R1-F 设计稿。

## 副作用顺序统一契约(所有迁移路径)
Validate → Authorize → **Mutate SoT(断言+回读)** → dependents(断言) → Audit → **Notify(最后)** → revalidate

## 静态闸 critical tables
orders / order_amendments / delay_requests / pre_order_price_approvals / order_financials / purchase_orders / order_commissions
