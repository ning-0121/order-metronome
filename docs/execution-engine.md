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

## Progressive Validation / 渐进式校验

> **核心原则**：订单创建不追求资料 100% 齐全；但关键执行节点完成前必须补齐。

### 为什么不全程必填

强制创建时填齐所有字段，会逼业务员在客户真没确认时填假数据绕过校验，反而污染数据。
现实情况：年年旺这类客户经常下单时只口头通知，仓库地址、联系人等需事后补充。

### 4 段式生命周期

```
T+0   创建：字段允许全空（UI 标注「待客户确认可空」）
T+5   开始催：missing_info 任务系统覆盖
T+7   生成催办任务（priority=2）
T+14  任务升级 priority=1（escalateStaleTasks）
T+N   尝试推关键节点 → hard-block，列出缺失项
T+N   补齐 → banner 消失 → 节点可推进
```

### 当前实例：国内送仓信息

| 字段 | 创建必填 | 催办起点 | Hard-Block 节点 |
|------|---------|---------|----------------|
| `delivery_warehouse_name` | ❌ | 7 天 | `packing_method_confirmed` |
| `delivery_address` | ❌ | 7 天 | `packing_method_confirmed` |
| `delivery_contact` | ❌ | 7 天 | `packing_method_confirmed` |
| `delivery_phone` | ❌ | 7 天 | `packing_method_confirmed` |
| `delivery_required_at` | ❌ | 7 天 | `packing_method_confirmed` |

**兜底**：上面节点被 admin 绕过后，`domestic_delivery` 节点再次硬阻塞（双闸门）。

**Admin Override**：`isAdmin === true` 可绕过 hard-block（应急放行）。

### 适用此模式的判断标准

要给某组字段套 Progressive Validation 时，必须同时满足：

1. **下游依赖明确** — 存在一个具体的执行节点，该节点不补齐这些字段就客观上做不下去
2. **创建期客观空缺** — 至少 20% 的真实订单在创建时拿不到这些信息（不是"业务员懒得填"）
3. **不卡到工厂** — 字段补齐前的所有节点都能并行推进，工厂可以同时开始生产

不满足这 3 条的字段，应当继续创建时强制必填。

### 反模式（已规避）

| 反模式 | 后果 |
|-------|------|
| ❌ 创建时硬必填 | 业务员填假数据绕过 → 数据污染 |
| ❌ 全程不校验 | 工厂排到包装环节才发现 → 已浪费排产时间 |
| ❌ 仅 UI 提示无 hard-block | 业务员忘记 → 工厂打错唛头 |
| ❌ 全节点 hard-block | 卡住生产 → 工厂等不到地址也不能开裁 |

### 共享性

此模式不含 Qimo 专属数据，登记为 `[SHARED]`。详见 [shared-core-registry.md](./shared-core-registry.md#delivery-info-progressive-validation-shared)。

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
