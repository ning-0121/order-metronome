# Decision Engine

> AI 是建议层，不是业务事实层。
> AI 永远不能直接控制主链路。

---

## AI Skill 系统

### 统一调度入口

```
lib/agent/skills/runner.ts → runSkill(skillName, input, supabase)
  ├─ 缓存检查（ai_skill_runs，input_hash 去重）
  ├─ 熔断检查（ai_skill_circuit_state，失败阈值）
  ├─ Shadow mode（灰度测试，结果不展示给用户）
  └─ 执行 Skill → 写入 ai_skill_runs
```

### 7 个 Skill

| Skill | 数据来源 | 是否调用 AI |
|-------|---------|------------|
| `risk_assessment` | milestones + delays + financials | ✅ |
| `missing_info` | orders + milestones | 规则为主 |
| `quote_review` | quoter | ✅（offline）|
| `customer_email_insights` | email logs | ✅ |
| `delay_prediction` | history + milestones | ✅ |
| `customer_confirmation` | orders + emails | ✅ |
| `outsource_risk` | factory + orders | ✅ |

### 统一输出 Contract（SkillResult）

```typescript
interface SkillResult {
  severity:    'high' | 'medium' | 'low'
  score?:      number           // 0-100，越高越严重
  summary:     string           // UI 卡片标题
  findings:    SkillFinding[]   // 详细发现，含 evidence（不能为空感觉）
  suggestions: SkillSuggestion[] // 建议动作，含 targetRole + needsApproval
  confidence:  number           // 0-100
  source:      'rules' | 'rules+ai' | 'cached'
}
```

**所有 AI 输出必须符合此 contract。** 禁止 AI 直接输出 UI 文案驱动逻辑，禁止 regex 解析自由文本。

---

## Decision Engine 允许写入的表

```
✅ daily_tasks          — suggestedTasks（建议任务）
✅ customer_rhythm      — profileUpdates（行为画像更新）
✅ order_retrospectives — 仅 4 个评分字段（ratings）
✅ notifications        — 通知
✅ ai_skill_runs        — 运行记录（runner 自动写）
✅ ai_skill_actions     — 用户采纳记录
```

## Decision Engine 严禁写入的表

```
❌ orders               — lifecycle_status, factory_date 等
❌ milestones           — status, planned_at
❌ order_financials     — 任何字段
❌ delay_requests       — 创建/审批（须走人工）
❌ profit_snapshots     — 财务数据
❌ shipment 相关表
```

---

## AI 调用规范

### 缓存策略

- 所有 AI 调用必须经过 `runner.ts`，不允许 Server Action 直接 `new Anthropic()`
- 缓存 key：`(skill_name, input_hash)`，相同输入复用结果
- 缓存失效：`invalidateOrderSkillCache(orderId)` 在里程碑状态变更后触发

### Token 成本管控

- 每次 Skill 运行记录 `token_estimate` 到 `ai_context_cache`
- `ai_skill_circuit_state` 跟踪失败次数，超阈值自动熔断

### Shadow Mode

- 灰度测试时 Skill 运行但结果不展示给用户
- 用于验证新 Skill 在生产数据上的准确率

---

## 当前禁止事项（Phase A）

```
❌ 新增 AI Skill（7 个已够，先用好再加）
❌ AI 直接执行订单操作（Tool Use）
❌ pgvector RAG（先积累结构化复盘数据）
❌ Autonomous Company 模式
❌ 新增 AI chat feature
```

---

*最后更新：2026-05-11*
