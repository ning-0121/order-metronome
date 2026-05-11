# Trade Agent OS — System Map

> **원칙**: 先可信，再智能。系统不是 ERP，是企业运行时（Enterprise Runtime）。
>
> 核心闭环：**风险 → 责任人 → deadline → escalation → retrospective → 学习**

---

## 系统层次

```
┌───────────────────────────────────────────────────────────────┐
│                        System Layer                            │
│  SoT 表（物化数据，只读，派生，可重建）                         │
│                                                               │
│  customer_rhythm       客户画像 SoT                           │
│  runtime_orders        交付置信度 SoT                         │
│  ai_context_cache      AI 上下文缓存 SoT                      │
│  daily_tasks           任务队列 SoT                           │
│  profit_snapshots      利润快照 SoT                           │
└────────────────────┬──────────────────────────────────────────┘
                     │ 读取（不计算）
┌────────────────────▼──────────────────────────────────────────┐
│                     Execution Engine                           │
│  驱动：风险 → 责任人 → deadline → escalation → retrospective  │
│                                                               │
│  milestones          18 关卡主链路                             │
│  delay_requests      延期申请与审批                            │
│  order_retrospectives 复盘记录                                 │
│  daily_tasks.service  任务生成 + 轻升级                        │
│  escalation-chain     里程碑通知路由（cron/reminders）         │
└────────────────────┬──────────────────────────────────────────┘
                     │ 建议层（不改主链路）
┌────────────────────▼──────────────────────────────────────────┐
│                     Decision Engine                            │
│  AI 是建议层，不是业务事实层                                   │
│                                                               │
│  lib/agent/skills/    7 个 Skill，统一 SkillResult contract   │
│  lib/agent/skills/runner.ts  统一调度、缓存、熔断               │
│  suggestedTasks → daily_tasks（写这里）                        │
│  profileUpdates → customer_rhythm（写这里）                    │
│  禁止写：orders/milestones/financials/shipment                 │
└───────────────────────────────────────────────────────────────┘
```

---

## 数据流向

### 订单生命周期 → System Layer

```
orders
  └─► milestones（18关卡）
        ├─► runtime_events（append-only）
        │     └─► runtime_orders（delivery_confidence）
        ├─► delay_requests
        │     └─► runtime_events
        └─► order_retrospectives
              └─► customer_rhythm.profile_updated_at（nightly）

order_financials
  └─► customer_rhythm（avg_deposit_delay_days 等）

profit_snapshots
  └─► customer_rhythm（avg_margin_pct 等）
```

### 任务生成路径

```
/api/cron/daily（每天 08:00）
  Step 1: syncAllCustomerRhythms     → customer_rhythm
  Step 2: rebuildAllCustomerRhythmPnl → customer_rhythm（P&L字段）
  Step 3: resolveStaleAlerts         → system_alerts
  Step 4: generateDailyTasks         → daily_tasks
            ├─ generateMilestoneTasks
            ├─ generateDelayApprovalTasks
            ├─ generateProfitWarningTasks
            ├─ generateCustomerFollowupTasks
            ├─ generateEmailActionTasks
            ├─ generateMissingInfoTasks    （Loop 1）
            └─ generateRetrospectiveTasks  （Loop 1）
  + escalateStaleTasks（fire-and-forget）
```

### Escalation 路径（4条，职责不重叠）

| Path | 触发 | 操作对象 | 动作 |
|------|------|---------|------|
| A `escalateStaleTasks` | daily cron | `daily_tasks` | priority bump + `escalate_count+1` |
| B `runEscalationChain` | reminders cron | `milestones` | 按角色发通知（Day+1/2/3/5）|
| C `escalate_ceo` | AI agent | CEO 通知 | 直接推送，不改 DB 主表 |
| D war room | 手动 | `order_amendments` | 走延期/变更审批 |

---

## 关键边界（不得跨越）

### Decision Engine 禁止写

```
❌ orders（status, lifecycle_status）
❌ milestones（status, planned_at）
❌ order_financials
❌ shipment 相关表
✅ daily_tasks（suggestedTasks）
✅ customer_rhythm（profileUpdates）
✅ order_retrospectives（仅评分字段）
✅ notifications（通知）
```

### 页面禁止计算

```
❌ 页面临时计算 customer profile
❌ 页面临时计算 delivery confidence
❌ 页面临时计算 priority scoring
✅ 页面只读 customer_rhythm（SoT）
✅ 页面只读 runtime_orders（SoT）
✅ 页面只读 daily_tasks（SoT）
```

### Cron 当前清单（主路径）

| Cron | 调度 | 职责 |
|------|------|------|
| `/api/cron/daily` | 每天 08:00 | rhythm + PnL + alerts + tasks |
| `/api/cron/reminders` | 每 15 分钟 | 通知发送 + 升级链 |
| `/api/cron/agent-scan` | 每天 | AI batch 分析 |
| `/api/cron/email-scan` | 每 15 分钟 | 邮件扫描 |

---

## 当前阶段

```
Phase A — 闭环建设期（当前）
  目标：可信系统 > 聪明系统
  完成：Loop 1（tasks）/ Loop 2（复盘）/ Loop 3（客户画像 SoT）
  进行：系统收口（SoT 统一 / Priority / Escalation）

Phase B — Profile 增强期（下一阶段）
  目标：customer_rhythm + factory_profile 自动物化
  前提：Loop 1-3 闭环稳定 ≥ 30 天

Phase C — Agent 协作期（未来）
  前提：Phase B 完成，数据质量可信
  限制：AI 永不直接写主链路
```

---

*最后更新：2026-05-11 | 版本：arch-convergence-step5*
