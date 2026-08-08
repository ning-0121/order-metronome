# R1-D Audit Fragmentation Map(只读扫描,2026-08-08)

> 原则:EVERY CRITICAL ACTION MUST BE PROVABLE. / AUDIT FAILURE MUST NEVER BE SILENT.

## 一、现存审计载体盘点(生产实查)

| 表 | 行数 | actor 字段 | before/after | 裸插/查error | RLS(迁移文本) | 保留期 |
|---|---|---|---|---|---|---|
| milestone_logs | 1,687 | `actor_user_id` | ✗(payload 自由格式) | **27 裸 / 2 查** | INSERT=authenticated(宽) | 无 |
| order_logs | 132 | **`actor_id` + `actor_user_id` 双列并存** | old/new_value 列 + payload | **13 裸 / 1 查** | **INSERT=仅订单创建人** ⚠ | 无 |
| agent_actions | 2,927 | executed_by/dismissed_by | rollback_data | 2 裸 | — | 无 |
| order_finance_events | 58 | ✗(无 actor!) | ✗ | 1 裸 / 1 查 | — | 无 |
| automation_runs | 9 | started_by | metadata | 0(R1-B 新建即规范) | SR-only 写 | 无 |
| ai_usage_log | 1,234 | user_id | ✗ | (telemetry,豁免) | — | 无 |
| decision_logs / execution_logs / audit_logs / tool_calls / approval_logs | **不存在** | — | — | — | — | — |

## 二、结构性病灶

1. **order_logs 的 INSERT RLS = 仅订单创建人**(20240121 迁移原文)——
   财务放货(business_override)、免验、经理操作等他人写审计**全部被静默拒收**;
   体检"财务放货/免验/重同步三类审计生产 0 条"由此实锤定因。
2. **actor 语义漂移**:`actor_user_id:` 35 处 vs `actor_id:` 5 处,order_logs 两列并存,
   谁是权威列无人说得清;`order_finance_events` 干脆没有 actor。
3. **43 处裸插**(milestone_logs 27 + order_logs 13 + agent_actions 2 + finance_events 1),
   96 条审计丢失事故的模式仍是主流写法。
4. **helper 本身就分叉**:`logMilestoneAction` 在 milestones.ts 与 delays.ts 各有一份副本。
5. **没有任何表有 decision/task/execution 关联字段**(R1-C 的 critical_mutation 是唯一例外,
   decision_id 在 payload 里)——「谁决定的/根据什么」目前无法系统性反查。
6. 审计表均无保留期(notifications 的教训会重演,量级尚小,列为观察项)。

## 三、统一方案(本轮实施)

- **不建新表**:`writeAuditEvent()` 统一入口按 entity 路由现有表(milestone→milestone_logs,
  order→order_logs),统一信封(actor{type,id,on_behalf_of}/command/reason/decision_id/
  before/after/risk)进 payload;**一律 service-role 写**(绕开创建人-only RLS)+ 行数断言。
- **Criticality 三级**:A0 尽力(失败=console+degraded 标记)/ A1 必需(失败=返回 audit_failed,
  不得显示完全成功)/ A2 强制(钱/发货/审批/不可逆:失败=Command 不得算 verified complete,
  进入 completed_unverified + 即刻告警 admin)。
- **actor 模型收口**:新代码统一 `actor_type('user'|'agent'|'system'|'cron') + actor_id +
  on_behalf_of_user_id`;落库仍写现有 `actor_user_id` 列(user 时)保持兼容,全量语义进 payload.actor;
  旧数据兼容读取,不回填。
- 两份 logMilestoneAction 副本内部改指 writeAuditEvent(调用点零改动,覆盖面立增)。

## 四、Critical Mutation Debt Register(与审计债分开计数)

自动分级(scripts/gen-mutation-debt-register.mjs → docs/architecture/critical-mutation-debt-register.json):

**critical 45 / medium 20 / low 0**(orders 36 处里 34 critical;purchase_orders 16 全 critical…)

Executive OS V1 获得真实执行权限前 critical_count 必须清零 —— 不在 R1-D 的 PASS 数字里。
