# Execution Engine

> 职责：驱动责任、驱动行动、驱动升级、驱动复盘。

---

## 任务系统（daily_tasks）

### 任务类型

| task_type | 触发条件 | urgentAfterDays | 描述 |
|-----------|---------|----------------|------|
| `milestone_overdue` | 里程碑逾期 | 1 | 立即升级 |
| `milestone_due_today` | 里程碑今日到期 | — | 初始 priority=2 |
| `delay_approval` | 延期申请待审批 | 2 | 等待 2 天升级 |
| `profit_warning` | 利润低于阈值 | — | 财务类警告 |
| `customer_followup` | 客户跟进到期 | — | 来自 customer_rhythm |
| `email_action` | 邮件需要回复 | — | 来自邮件解析 |
| `missing_info` | 关键字段未填写 | 14 | 创建 14 天升级 |
| `decision_required` | 订单待复盘 | 7 | 完成 7 天升级 |
| `system_alert` | 系统告警 | — | 固定 priority=1 |

### Priority 规则

```typescript
// 唯一 Priority 计算函数（lib/services/daily-tasks.service.ts）
computeTaskPriority(staleDays: number, urgentAfterDays: number): 1 | 2 | 3
// staleDays >= urgentAfterDays → 1（紧急）；否则 → 2（中等）
```

priority=3 目前未使用（无 generator 产生）。

### 去重机制

```sql
UNIQUE(assigned_to, source_type, source_id, task_date)
```

同一天同一来源同一用户只生成一条任务，重复插入静默忽略。

### 轻升级（escalateStaleTasks）

- 触发：`/api/cron/daily` 末尾，fire-and-forget
- 条件：`status=pending AND task_date < yesterday AND priority > 1`
- 动作：`priority` bump + `escalate_count + 1`
- `escalate_count` 由 `order-decision.ts` 读取判断订单是否 `at_risk`

---

## 延期申请流程

```
用户发起延期申请
  → delay_requests 表（status=pending）
  → 触发 runtime_events（delay_approved）
  → generateDelayApprovalTasks → 审批人 daily_task
  → 审批人处理 → delay_requests.status = approved/rejected
  → 触发 recomputeDeliveryConfidence（fire-and-forget）
```

**订单级延期**（`createOrderLevelDelayRequest`）：
- 找 `booking_done` 节点为锚点，创建延期申请
- 通知 admin + CEO
- 不直接修改 `factory_date`，走审批链路

---

## 复盘系统（order_retrospectives）

### 触发条件

`lifecycle_status` ∈ `{completed, 已完成, 待复盘, 已复盘}` → 显示复盘标签页。

### 两个入口

| 入口 | 动作 | 数据 |
|------|------|------|
| `RetrospectiveTab` 快速评分 | `saveRetrospectiveRatings` | 4 个评分字段 |
| `/orders/[id]/retrospective` 完整复盘 | 完整表单 | 全部字段 |

快速评分支持无完整复盘时先写评分（插入 key_issue='' 占位符），等完整复盘覆盖。

### 字段所有权

| 字段 | 写入方 |
|------|-------|
| `key_issue / root_cause / what_worked / improvement_actions` | 完整复盘表单 |
| `on_time_delivery / major_delay_reason` | 完整复盘表单 |
| `customer_satisfaction / factory_rating / will_repeat_*` | 快速评分 或 完整复盘 |
| `final_margin_pct` | profit.service materializer |

---

## Escalation 路径（4条）

详见 [system-map.md](./system-map.md#escalation-路径4条职责不重叠)

---

## 18 关卡系统

### 阶段划分

```
Phase A（7关）：PO确认 → 财务审批 → 订单资料 → 采购单 → 采购审批 → 采购下单 → 原料检验
Phase B（4关）：产前样完成 → 寄出 → 确认 → 大货启动
Phase C（5关）：中期验货 → 尾期验货 → 包装到位 → QC预约 → QC完成
Phase D（2关）：订舱完成 → 出运完成
```

### 关键节点（影响 delivery_confidence）

```
finance_approval / production_kickoff / factory_completion /
booking_done / domestic_delivery / mid_qc_check /
final_qc_check / inspection_release
```

超期惩罚：8+天 -25 / 3-7天 -15 / 1-2天 -8，类别封顶 -40，递减叠加。

---

*最后更新：2026-05-11*
