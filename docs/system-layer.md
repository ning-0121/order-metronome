# System Layer

> 物化表：派生数据，可重建，不允许页面临时计算。
> 每张表有且只有一个写入者（materializer）。

---

## customer_rhythm

**职责**：客户画像唯一 SoT（Single Source of Truth）

**写入者**：`lib/services/customer-rhythm.service.ts`

**Rebuild 策略**：`/api/cron/daily` Step 1 + Step 2

```
Step 1: syncAllCustomerRhythms()
  → 从 orders 聚合：tier, followup_status, risk_score, active_order_count 等
  → 创建不存在的行，更新已有行

Step 2: rebuildAllCustomerRhythmPnl()  [本次新增]
  → 调用 computeCustomerPnl()（lib/services/customer/customer-pnl.service.ts）
  → 写入：avg_margin_pct, total_revenue_cny, margin_trend,
          on_time_delivery_rate, avg_deposit_delay_days,
          overdue_payments, behavior_tags, profile_updated_at
  → 前提：Step 1 已执行（行已存在）
```

**字段所有权**

| 字段组 | 写入方 | 页面可改 |
|-------|-------|---------|
| tier, followup_status, risk_score | rhythm service | ❌ |
| next_followup_at, followup_interval_days | rhythm service（初始），sales 手动 | ✅ |
| notes | sales 手动 | ✅ |
| avg_margin_pct … behavior_tags | pnl materializer | ❌ |
| last_contact_at | `recordCustomerContact()` 调用后 | ❌（通过 action）|

**降级行为**：`profile_updated_at IS NULL` → 前端显示"暂无画像数据"，不阻塞渲染。

---

## runtime_orders

**职责**：每订单最新交付置信度（delivery_confidence）

**写入者**：`app/actions/runtime-confidence.ts → recomputeDeliveryConfidence()`

**Rebuild 触发（4 个钩子，fire-and-forget）**

| 钩子触发点 | 事件类型 |
|----------|---------|
| `milestonesRepo.updateMilestone` 成功后 | `milestone_status_changed` |
| `approveDelayRequestCore` 末尾 | `delay_approved` |
| `executeSideEffects(recalc_schedule)` | `anchor_changed` |
| `applyReschedule` 末尾 | `amendment_applied` |

**Feature Flag**：`RUNTIME_CONFIDENCE_ENGINE` = `off` / `admin` / `on`

**数据来源**：`milestones + delay_requests + order_financials`（不读 runtime_orders 自身）

**append-only**：`runtime_events` 永不 UPDATE/DELETE，`runtime_orders` 用 version 做乐观并发。

---

## daily_tasks

**职责**：每用户每日任务队列

**写入者**：`lib/services/daily-tasks.service.ts → generateDailyTasks()`

**Rebuild 策略**：`/api/cron/daily` Step 4（幂等，UNIQUE 约束去重）

**SoT 保证**：
- `UNIQUE(assigned_to, source_type, source_id, task_date)` 防重
- `status` 字段由用户操作改变（done/snoozed/dismissed），cron 不重置
- `escalate_count` 由 `escalateStaleTasks` 自增，审计升级历史

---

## profit_snapshots

**职责**：每订单利润快照（forecast / live / final）

**写入者**：`app/actions/profit.ts` 及 profit.service

**优先级**：`final > live > forecast`（所有读取方必须遵守此优先级）

**读取方**：
- `computeCustomerPnl()`（批量聚合）
- `RuntimeRiskCard`（单订单展示）
- 分析页（analytics/execution）

---

## ai_context_cache

**职责**：AI 上下文缓存，避免重复 token 消耗

**写入者**：`lib/agent/skills/runner.ts`

**Key**：`(context_type, entity_id)` UNIQUE

**失效**：`is_stale=true` 或 `valid_until` 过期，或 `invalidateOrderSkillCache()` 手动触发

---

## 禁止事项

```
❌ 页面组件 .tsx 文件直接查询 profit_snapshots 计算 margin
❌ 页面组件直接计算 customer behavior tags
❌ 多处代码各自读 runtime_orders 并重新推导 confidence
❌ Server Action 直接绕过 runner.ts 调用 Anthropic SDK
```

---

## 数据新鲜度监控

| 表 | 新鲜度指标 | 告警阈值 |
|----|----------|---------|
| `customer_rhythm` | `profile_updated_at` | > 48h 未更新 |
| `runtime_orders` | `updated_at` | > 24h 未更新（活跃订单）|
| `daily_tasks` | `task_date` | 今日 0 条 = cron 故障 |
| `ai_skill_runs` | `created_at` | > 7 天无新运行 = cron 故障 |

---

*最后更新：2026-05-11*
