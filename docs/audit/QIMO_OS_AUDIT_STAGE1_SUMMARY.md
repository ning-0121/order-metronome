# QIMO OS 全系统审计 Stage 1 摘要

日期：2026-07-19

## 当前真相

- `origin/main`: `ac5d855eed7865f929ead11c4ad8c2d6e2889617`
- Production：当前已知仍停留在上一版已验证的生产 SHA，未与 `origin/main` 同步。
- 结论：Production 与 main 不一致。

## 审计分工

已建立的审计 worktree：

- `/Users/ning/Projects/order-metronome-audit-dev`
- `/Users/ning/Projects/order-metronome-audit-finance`
- `/Users/ning/Projects/order-metronome-audit-issues`
- `/Users/ning/Projects/order-metronome-audit-lineage`
- `/Users/ning/Projects/order-metronome-audit-management`
- `/Users/ning/Projects/order-metronome-audit-order`
- `/Users/ning/Projects/order-metronome-audit-procurement`
- `/Users/ning/Projects/order-metronome-audit-roadmap`
- `/Users/ning/Projects/order-metronome-audit-routes`
- `/Users/ning/Projects/order-metronome-audit-security`
- `/Users/ning/Projects/order-metronome-audit-technical`
- `/Users/ning/Projects/order-metronome-audit-tests`
- `/Users/ning/Projects/order-metronome-audit-workflow`

已激活 Agent：

- `/root/audit_finance_system`
- `/root/audit_management_dashboard`
- `/root/audit_route_button_inventory`

## 基础库存

- 页面路由：71
- 布局：2
- Route Handlers：57
- Server Action 文件：122
- 组件文件：146
- lib 文件：251
- `alert()` 调用：217
- migration SQL 文件：161

## 已取得的高风险证据

### 1) 数据分析页全量读订单并直接聚合

`app/analytics/page.tsx:13-42`

- 整页对任意 action 失败只做降级和日志，不会阻断页面渲染。
- 直接从 `orders` 全量读取 `id, customer_name, factory_name, quantity, created_at`。
- 页面级总件数、客户数、工厂数都在客户端/页面内直接聚合。

`app/actions/analytics.ts:78-88`

- 订单总数口径使用 `order_purpose='production'`。
- 里程碑口径只看生产订单。

### 2) 订单页仍是大列表工作台

`app/actions/orders.ts:1070-1106`

- `getOrders()` 对管理员/经理类角色直接读取订单全量列表。
- `ORDERS_HARD_LIMIT = 2000`，当前不是 summary-only 首页模型。
- 同时预取订单里程碑，形成较重的初始负载。

### 3) 角色映射存在隐式降级

`lib/domain/roles.ts:78-115`

- `normalizeRoleToDb()` 对未知角色默认回退到 `sales`。
- 这类隐式 fallback 会掩盖角色数据异常。

### 4) 客户年度目标与分析页口径已分流

`app/sales-targets/page.tsx:17-170`

- 页面标题与总览卡使用“件数”口径，但数据来源是按 `orders.quantity` 和农历年范围聚合。
- 角色限制为 `admin / finance / sales`，和 analytics 的管理层视角不完全同构。

`app/actions/sales-targets.ts:80-167`

- 仅排除 `cancelled/已取消`。
- 直接把 `orders.quantity` 当成年度完成件数聚合，不区分商业数量、物理件数、贸易单、样品单等更细口径。

## 初步问题登记

### P0

1. 发布真相不一致：`origin/main` 已更新，但 Production 未同步。
2. 审计范围内存在高风险的全量数据读取与重口径聚合页面，可能继续放大口径偏差。

### P1

1. `analytics` 页全量读取并直接聚合订单。
2. `orders` 页仍以大列表为主，不是 summary-first。
3. 角色映射存在未知值默认回退到 `sales`。
4. `sales-targets` 与 `analytics` 的件数/完成口径存在明显分流风险。

### 当前问题台账状态

- 已确认 P0：`1`
- 已确认 P1：`5`

## 已确认暂未完成的角色流程

- 业务开发
- 业务执行
- 采购
- 生产主管
- 生产跟单 / QC
- 物流
- 财务
- 管理层 / 老板

当前仅确认未登录场景的基础跳转可用，未确认任何完整员工日常闭环。

## 下一阶段建议

继续做静态审计与只读抽样验证，优先锁定：

1. 订单 / 采购 / 生产 / 物流的路由与按钮全量清单
2. 财务链路与金额口径
3. 高冲突 server actions 的数据映射与状态机
4. 形成可执行的 P0/P1 问题台账，再进入修复批次
