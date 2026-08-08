# R1-E Truth & Permission Gate(2026-08-09)

> ONE BUSINESS TRUTH. ONE PERMISSION TRUTH.

## 一、Management Truth Map(管理数字来源盘点)

| 指标族 | 来源表 | 过滤/口径 | 聚合位置 | 1000行风险 | 双轨口径 | 状态 |
|---|---|---|---|---|---|---|
| CEO 超期/阻塞清单+计数 | milestones⋈orders | 排除终结单+回填豁免 | Node | **曾截断(P0)** | 单一 | ✅ 已修(fetchAllPages) |
| analytics 完成率/准时率 | milestones⋈orders(production) | isDone 归一 | Node | **曾截断(P0):76%虚→72%真** | 单一 | ✅ 已修 |
| 角色评分 S-D | milestones + delay_requests | owner_role 分桶 | Node | **曾截断(P0):26%样本** | 单一 | ✅ 已修 |
| Agent 动作分布 | agent_actions | 按 type/status | Node | **曾截断(P2):头尾自相矛盾** | 单一 | ✅ 已修 |
| AI 知识分布 | ai_knowledge_base(active) | 按 type/source | Node | **曾截断(P2)** | 单一 | ✅ 已修 |
| 订单件数/金额 | orders | isStatCountableOrder 单一源 | count/头部 | 低(204 行) | 单一(2026-07 收口) | ✅ 抽查通过 |
| 订单分组(进行/完成) | orders+milestones | orderGrouping.ts 单一源 | Node | 低(经 attachMilestones 分页) | 单一 | ✅ |
| 生产 KPI(节点考核) | milestones | 跨过率口径 | Node | ⚠ analytics-detail.ts:216/384 临界(单人 817 行) | 单一 | 👁 观察名单(入 lint:truth 路径) |
| 财务 KPI | order_financials(208 行) | — | Node | 低 | 单一 | ✅ 抽查 |
| 客户 KPI | customer_rhythm(29 行) | — | Node | 低 | 单一 | ✅ |

**独立对账(生产,2026-08-09)**:
- 完成率:旧(截断)**76%** / 真相(独立 SQL 分页 3793 行)**72%** / 新路 **72%** —— 差 0 ✅
- 样本数:新路 totalMilestones = 3793 ≡ 真相 ✅
- 超期:全量口径 141(生产单)/head 计数 147(全订单,差=非生产单)—— 口径差已说明 ✅

**角色评分 before/after(样本 1000→3793)**:

| 角色 | 旧分/档(截断) | 新分/档(全量) |
|---|---|---|
| 业务执行 merchandiser | 80 / B | **67 / D** |
| 业务开发 sales | 89 / B | **78 / C** |
| 采购 | 92 / A | **87 / B** |
| 生产部主管 | 90 / A | 91 / A |

⚠ **排名发生显著变化 → 过去历史评分不可信,不做自动追责**(CEO 规则)。

**Truth Query 基建**:`lib/db/truth-query.ts`(fetchAllPages / getExactCount / fetchAllVerified——
对不上宁可报错不给假数);静态闸 `lint:truth` 盯 CEO/analytics/评分/财务路径,新增裸全量即 fail(存量 41 入棘轮)。

## 二、Permission Matrix(权限注册表)

execution_mode:**A=DB-enforced**(RLS 与 server 一致)/ **B=Command-enforced**(代码鉴权→svc→safeMutation→审计;service-role ≠ 无权限模型,是权限由服务层业务命令接管)。

| permission_key | allowed_roles | scope | risk | mode | db_enforce | server_enforce | agent_allowed |
|---|---|---|---|---|---|---|---|
| CAN_EDIT_ORDER | 创建人/owner/admin | entity | money | A(orders RLS 2024 版) | ✅ | ✅ | ❌ |
| CAN_APPROVE_PRICE | admin, sales_manager | global | money | **B**(R1-C 落地) | svc | ✅ canApprovePrice | ❌ |
| CAN_REJECT_DELAY | 链上对口角色+CAN_APPROVE_DELAY | entity | delivery | **B**(R1-C 落地) | svc | ✅ canActOnDeferralStep | ❌ |
| CAN_RELEASE_SHIPMENT | admin(仅 override 函数) | entity | money | B + A2 审计 | svc | ✅ | ❌ |
| CAN_EDIT_BOM | 见 ROLE_GROUPS.CAN_EDIT_BOM | entity | delivery | A | RLS | ✅ | ❌ |
| CAN_VIEW_PROCUREMENT_PRICE | =CAN_SEE_PROCUREMENT_FLOOR(admin/finance/采购线) | read | money | **投影**(本轮落地) | — | ✅ select 剥列 | ❌ |
| CAN_VIEW_FINANCIALS | admin/finance/sales线 | read | money | 投影(既有) | — | ✅ | ❌ |
| CAN_TRANSFER_ORDER_OWNER | =CAN_REASSIGN_OWNER | entity | permission | **B**(R1-C 落地) | svc | ✅ | ❌ |
| CAN_MARK_INSPECTION_WAIVER | QC线+admin | entity | delivery | **B**(R1-C 落地,A1 审计) | svc | ✅ | ❌ |
| CAN_EDIT_SAMPLE_FEE | finance/sales线 | entity | money | **B**(R1-C 落地) | svc | ✅ | ❌ |
| CAN_MANAGE_SPLIT_SHIPMENT | logistics+跟单线 | entity | delivery | **B**(R1-C 落地) | svc | ✅ | ❌ |

角色读取唯一口径:`canonicalRoles(profile)`(lib/domain/roles.ts);新代码单列 `profile.role===` 判权限被 lint:role 拦。

## 三、Confirmed 断点闭环状态

| 断点 | 状态 |
|---|---|
| Delay reject 经理驳不动 | ✅ R1-C 落地(B 模式),生产 smoke 已证 |
| Price approval 经理批了库 pending | ✅ R1-C 落地,生产 smoke 已证 |
| daily_tasks 跨用户清理 | ✅ markMilestoneDone 已修;batch/agent 完成路径经同一 helper(本轮核对) |
| orders 跨用户写 6 项 | ✅ R1-C 落地 |
| 采购跟踪泄价 | ✅ 本轮:显式列 + CAN_SEE_PROCUREMENT_FLOOR 投影 |

## 四、Debt Register 重分类(executive_os_blocker)

见 critical-mutation-debt-register.json:critical 23 中,标记 **executive_os_blocker=true** 的为
订单生命周期/PO 状态/财务金额类共 **14 处**(Executive OS V1 会调用的命令面);其余 9 处为
人工低频维护路径。blocker 清零是 V1 真执行前置门槛(维持 R1-D 结论,不混入本轮 PASS)。
