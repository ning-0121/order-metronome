# Order Metronome 2.0 — Runtime Engine Phase 1

**目标**：把"准时交付概率（Delivery Confidence）"做成订单运行时的核心信号，
取代"X 个节点逾期"这种历史统计为主的评价。

**指导原则**：复用现有表（delay_requests / milestone_logs / order_decision_reviews / agent_actions /
order_logs），不开双轨；所有写入异步、append-only、可回滚。

---

## 范围（敲定版）

### 包含
1. 1 张新表 `runtime_events`（append-only 事件源）
2. 1 张新表 `runtime_orders`（每订单最新置信度状态，可回滚）
3. `lib/runtime/deliveryConfidence.ts` 纯函数计算引擎（含 explain_json）
4. `lib/runtime/criticalNodes.ts` — 标识关键路径节点（不做完整 DAG）
5. 4 个写入钩子：milestone 状态变更 / delay 批准 / order 字段编辑 / amendment 应用 → 异步重算
6. 改造 OrderBusinessPanel 风险卡：从"逾期数量"改为"是否影响交付 + 原因 + 下一步"

### 不包含（明确排除）
- DAG 依赖图（Phase 2）
- AI Copilot 问答（Phase 2）
- Runtime Dashboard 总览页（Phase 2）
- 工厂稳定性指标（Phase 2/3）
- Coordination Engine 主动协同（Phase 3）
- Learning / Simulation（Phase 3）

---

## 数据模型

### `runtime_events`（append-only）
```sql
id              uuid PK
order_id        uuid FK
event_type      text  -- milestone_status_changed | delay_approved | anchor_changed | amendment_applied | external_signal
event_source    text  -- 'milestone:<id>' | 'delay_request:<id>' | 'manual' | ...
severity        text  -- info / warning / critical
payload_json    jsonb -- 原始数据，供后续重放/回滚/审计
created_by      uuid FK auth.users
created_at      timestamptz default now()
```

**所有 confidence 重算必须由 runtime_events 触发**，事件先入库再重算（保证可回放）。

### `runtime_orders`（最新状态投影）
```sql
order_id              uuid PK FK orders(id)
delivery_confidence   int        -- 0-100
risk_level            text       -- green / yellow / orange / red
predicted_finish_date date
buffer_days           int        -- 距最终交付的剩余缓冲
last_event_id         uuid FK runtime_events(id)
last_recomputed_at    timestamptz
explain_json          jsonb      -- 结构见下
version               int        -- 乐观并发
```

**explain_json 结构**（员工和老板都能看懂）：
```json
{
  "headline": "交付有风险（67%）",
  "reasons": [
    { "code": "fabric_late", "label": "面料晚 3 天到货", "delta": -15, "weight": "high" },
    { "code": "buffer_consumed", "label": "已消耗 60% 缓冲", "delta": -10, "weight": "medium" }
  ],
  "next_blocker": {
    "step_key": "production_kickoff",
    "name": "大货启动",
    "due_at": "2026-05-12",
    "owner_role": "production",
    "why_blocked": "等面料到齐"
  },
  "next_action": "采购催面料 / 业务确认是否可改面料供应商",
  "computed_at": "2026-05-06T10:00:00Z"
}
```

### 4-tier 风险等级判定
| 等级 | 条件 |
|------|------|
| 🟢 green  | confidence ≥ 85 |
| 🟡 yellow | 70 ≤ confidence < 85 |
| 🟠 orange | 50 ≤ confidence < 70 |
| 🔴 red    | confidence < 50 |

---

## 关键路径节点（Phase 1 简化版）

不做完整 DAG。先标记 7 个对最终交付有直接影响的节点，其它节点延期不直接拉低 confidence：

```ts
const CRITICAL_STEP_KEYS = [
  'finance_approval',
  'procurement_order_placed',
  'pre_production_sample_approved',
  'production_kickoff',
  'final_qc_check',
  'factory_completion',
  'booking_done',           // 出口
  'domestic_delivery',      // 国内送仓
];
```

非关键节点（如确认链单项、附件类）延期只贡献小权重扣分。

---

## 钩子点（4 处）

| 触发位置 | 投影成 event_type | 实现位置 |
|----------|-------------------|----------|
| `milestonesRepo.updateMilestone` 状态/截止变更 | `milestone_status_changed` | repo 写完后异步 fire |
| `approveDelayRequest` 批准成功 | `delay_approved` | action 末尾 fire |
| `orders` 表 factory_date / etd / warehouse_due_date 修改 | `anchor_changed` | order-amendments.ts 末尾 |
| `applyAmendment` 副作用执行后 | `amendment_applied` | order-amendments.ts |

**实现方式**：
```ts
// fire-and-forget，不阻塞主链路
void recomputeDeliveryConfidence(orderId, event).catch(err =>
  console.error('[runtime]', err.message)
);
```

---

## Rollback 策略

- `runtime_orders` 用 `version` 列做乐观并发
- 每次重算前留底，更新失败回滚到上一个版本
- `runtime_events` 永不删除，能回放出任何时间点的状态
- Feature flag `RUNTIME_CONFIDENCE_ENABLED=true` 全局开关，关掉立刻回退到老风险卡显示

---

## 10 天计划

### Day 1（今天）— 闭旧 bug + 文档
- [x] 写本文档
- [x] Bug 1 修复验证（QC 凭证 service-role）— 已修，等 QA
- [ ] Bug 2 修复（dashboard 排除 blocked）
- [ ] Bug 3 修复（风险卡前瞻化）

### Day 2 — 数据层
- 写 SQL migration：`runtime_events` + `runtime_orders` 表 + RLS + 索引
- 实现纯函数 `criticalNodes.ts`（关键节点常量 + 工具函数）
- 添加 feature flag

### Day 3 — 计算引擎核心
- 实现 `lib/runtime/deliveryConfidence.ts` 纯函数
  - `computeConfidence(order, milestones, financials, delayRequests) → { score, reasons, ... }`
- 单元测试：5 种典型 case（正常/缓冲消耗/关键延期/blocked/已交付）

### Day 4 — Recompute 投影器
- `recomputeDeliveryConfidence(orderId, event)` 服务端动作
- 写 runtime_events + 计算 + 写 runtime_orders（带乐观并发）
- 集成测试：手动 trigger 一个事件验证全链路

### Day 5 — 4 个钩子接入
- 4 个写入位置 fire 异步事件
- 不阻塞主链路（所有 catch）
- Vercel logs 验证无错误

### Day 6 — UI 改造
- 风险卡（OrderBusinessPanel）：读 runtime_orders.explain_json，渲染 headline + reasons + next_action
- 兜底：runtime_orders 没数据时降级显示老卡

### Day 7 — Backfill + 回归
- 一次性脚本：为所有 active 订单初始化 runtime_orders（基于当前 milestones 状态算一次）
- 回归测试：审批延期 → confidence 自动更新；订单详情风险卡显示新内容

### Day 8 — 文档 + Test 补全
- 更新 CLAUDE.md（新表、新引擎、回滚开关）
- 加入 `scripts/pre-deploy-check.ts` 检查项
- 补单元 / 集成测试

### Day 9 — Soak（灰度）
- Feature flag 开给 admin only 观察 24h
- 检查：
  - runtime_events 写入是否正常
  - confidence 数值是否合理
  - 风险卡 explain 文案是否友好
- 如有 bug 修复

### Day 10 — 全开 + 收尾
- Feature flag 全开
- 写 Phase 1 验收报告
- 列出 Phase 2 优先级（DAG / Critical Path / AI Copilot）

---

## Bug 1 验证手册（给 QA / 用户）

**修复内容**：`app/actions/milestones.ts` 凭证检查改用 service-role 客户端绕过 RLS。

**验证步骤**：
1. 登录非 admin 账号（如：秦增富 / 许继平）
2. 打开任意有未完成中查/尾查节点的订单（如 QM-20260403-014）
3. 确认订单详情页有 `qc_report` 类型附件
4. 点击中查节点的「✅ 完成」按钮
5. **预期**：直接成功，不再弹"需要凭证"
6. **若仍失败**：去 Vercel Logs 搜 `evidence_required`，把日志贴回来

---

## Bug 2 修复说明

**问题**：dashboard 的"我的逾期 / 他人逾期"把 `blocked` 状态节点也算逾期，
但 blocked 已经显式暂停（被驳回延期 / 被卡住），不应计入逾期数。

**修复**：3 处查询的过滤条件加上 `blocked`：
- `app/dashboard/page.tsx`：todayDue + allOverdue + blocked 列表分离
- `lib/engine/orderBusinessEngine.ts`：calculateBusinessRisk + calculateDelayRisk

---

## Bug 3 修复说明

**问题**：风险卡显示"X 个节点逾期"是历史统计，员工和老板看到没法行动。

**修复**（Phase 1 临时版，Day 6 会用 runtime 引擎进一步重写）：
- `calculateBusinessRisk` 改为：
  - 不再以"逾期数量"为主指标
  - 改为：当前是否有关键路径节点延期？延期是否会突破缓冲？
- `calculateDelayRisk` 改为：
  - explain 文案改为前瞻式："下一关键节点 X，距 Y 天，缓冲剩 Z 天"
  - 不再说"几个节点逾期"
- UI（OrderBusinessPanel）：风险卡显示 next_blocker / next_action

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| confidence 算错导致误报/漏报 | feature flag 关掉就回退 |
| 钩子异步失败导致 runtime_orders 不一致 | runtime_events 永远是真相，可重算 |
| 数据库压力 | runtime_events 用月度分区（Phase 1 不做，Phase 2 上量再加） |
| 老卡逻辑回归 | 保留兜底，老逻辑作为 runtime_orders 缺失时的 fallback |

---

最后更新：Day 1 启动
