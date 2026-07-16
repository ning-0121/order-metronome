# QIMO 订单责任生命周期完成记录

日期：2026-07-16  
分支：`fix/qimo-role-responsibility-implementation`  
状态：Preview 实现；Production 代码未部署；历史订单不回填。

## 生命周期

- 采购：采购项通过预算/财务门禁并确认后，由实际采购人员接收 `procurement_owner`；重复接收幂等。部分收货不结束；全部已批准采购义务收齐才结束。草稿、复核和取消项不构成未完成义务。
- 物流：物流人员首次接受出货子任务时接收 `logistics_owner`；订舱不会结束责任。物流子任务全部完成、物理出货/送仓完成且装箱凭证存在后才结束。
- 财务：采用事件驱动队列（方案 B）。不自动创建 `finance_owner`；付款、入账、结算权限继续由财务 RBAC/审批决定，责任行不授予财务权限。
- 取消/结案：订单取消或满足现有结案规则后，集中 RPC 结束全部 active 显式责任，保留完整历史。RPC 缺失且存在 active 行时不会静默成功，会产生结案核对事项。

## 通知

- QC 不合格：生产跟单/QC、生产主管、业务执行；缺失显式责任时进入相应经理角色队列。
- 缺料：采购、生产主管、生产跟单/QC、业务执行；使用稳定 `matter_key` 去重。
- 延期：生产主管、业务执行；影响客户承诺时追加商业经理。
- 出货阻塞：物流、业务执行及实际 QC/财务/采购/生产 blocker owner；无显式 owner 时按 blocker 路由到对应职能角色。

## 兼容与一致性

- 所有读取优先显式责任，否则使用 `legacy_derived`，不写回历史订单。
- Dashboard、生产中心、采购中心和物流中心均纳入显式/有效责任；缺失 owner 显示为待经理分配，不回退 Sales。
- 全单出货、分批出货、多方确认自动完成、国内送仓、`shipment_confirmations` 新旧执行入口均调用同一服务端 shipment gate。
- Production 当前责任表为 0 行，因此旧代码继续按 legacy owner/milestone 工作；新代码部署后，新触发才写显式责任。

## 部署顺序

1. CEO 在 SQL Editor 执行并验证 RPC hardening（`replace_order_responsibility`、`end_order_responsibility`、`end_all_order_responsibilities` 和 updated_at trigger）。
2. 只读验证函数权限仅 `service_role`，两表 RLS 仍启用。
3. 部署兼容代码。
4. 用授权的 disposable order 完成员工验收；不得回填历史订单。

