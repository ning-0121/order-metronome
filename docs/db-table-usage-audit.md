# 数据库表使用审计

> 生成时间：2026-04-27  
> 审计工具：代码 grep 引用统计 + Cron 写入分析  
> 版本：System Consolidation Sprint v1

---

## 分类说明

| 分类 | 含义 |
|------|------|
| ✅ ACTIVE | 订单主链路正在使用，有 UI 读写 |
| 📥 PASSIVE | 有代码写入但无直接 UI 展示 |
| 👻 GHOST | 代码引用 < 2 处，可能无数据 |
| ⚠️ DANGEROUS | 被已禁用的 Cron 自动写入，存在副作用 |
| 📦 ARCHIVE_CANDIDATE | 无近期更新、非主链路，未来可归档 |

---

## 核心订单链路（ACTIVE）

### orders
- **分类**：✅ ACTIVE
- **代码引用**：221 处（最高）
- **UI 读取**：是（订单列表、详情、新建、所有关联页面）
- **Cron 写入**：proactive-fix（已禁用）修改 lifecycle_status
- **影响订单主链路**：是（核心表）
- **建议**：保留，严禁结构变更

### milestones
- **分类**：✅ ACTIVE
- **代码引用**：207 处
- **UI 读取**：是（订单详情页 18 关卡）
- **Cron 写入**：proactive-fix（已禁用）自动 assign owner_user_id
- **影响订单主链路**：是（关卡推进核心）
- **建议**：保留，proactive-fix 禁用后 owner_user_id 需人工分配

### profiles
- **分类**：✅ ACTIVE
- **代码引用**：157 处
- **UI 读取**：是（权限、用户信息、头像）
- **Cron 写入**：无
- **影响订单主链路**：是（权限验证）
- **建议**：保留

### notifications
- **分类**：✅ ACTIVE
- **代码引用**：78 处
- **UI 读取**：是（通知中心）
- **Cron 写入**：reminders、order-audit、cost-monitoring 均写入（安全）
- **影响订单主链路**：是（通知驱动）
- **建议**：保留

### milestone_logs
- **分类**：✅ ACTIVE
- **代码引用**：37 处
- **UI 读取**：是（操作审计日志）
- **Cron 写入**：无
- **影响订单主链路**：是（审计追溯）
- **建议**：保留

### delay_requests
- **分类**：✅ ACTIVE
- **代码引用**：35 处
- **UI 读取**：是（延期审批页面）
- **Cron 写入**：无
- **影响订单主链路**：是（延期核心）
- **建议**：保留

### order_attachments
- **分类**：✅ ACTIVE
- **代码引用**：44 处
- **UI 读取**：是（凭证上传、节点附件）
- **Cron 写入**：无
- **影响订单主链路**：是（凭证校验核心）
- **建议**：保留；已修复 INSERT 静默失败 bug（2026-04-27）

### order_financials
- **分类**：✅ ACTIVE
- **代码引用**：22 处
- **UI 读取**：是（订单经营数据页）
- **Cron 写入**：无
- **影响订单主链路**：是（利润把控）
- **建议**：保留；已通过 quote-bridge 打通报价数据流

---

## 功能型活跃表（ACTIVE / PASSIVE）

### agent_actions
- **分类**：✅ ACTIVE
- **代码引用**：56 处
- **UI 读取**：是（/admin/agent 页面展示统计和动作列表）
- **Cron 写入**：agent-scan（已从 Vercel 调度移除，但代码可手动触发）
- **影响订单主链路**：间接（催办、升级动作）
- **建议**：保留；agent-scan 禁用后新数据减少，admin 页面仍可查历史

### order_cost_baseline
- **分类**：✅ ACTIVE
- **代码引用**：14 处
- **UI 读取**：是（成本录入、报价对比）
- **Cron 写入**：cost-monitoring（读取，不写入）
- **影响订单主链路**：是（成本管控基准）
- **建议**：保留

### quoter_quotes
- **分类**：✅ ACTIVE
- **代码引用**：16 处
- **UI 读取**：是（报价员页面）
- **Cron 写入**：无
- **影响订单主链路**：是（报价→订单链路）
- **建议**：保留；quote-bridge 已建立到 order_financials 的数据流

### quoter_cmt_training_samples
- **分类**：✅ ACTIVE
- **代码引用**：19 处
- **UI 读取**：是（报价训练数据管理页）
- **Cron 写入**：无
- **影响订单主链路**：否（报价辅助）
- **建议**：保留

### procurement_line_items
- **分类**：✅ ACTIVE
- **代码引用**：14 处
- **UI 读取**：是（采购录入页）
- **Cron 写入**：cost-monitoring（只读）
- **影响订单主链路**：是（采购环节）
- **建议**：保留

### customers
- **分类**：✅ ACTIVE
- **代码引用**：13 处
- **UI 读取**：是（客户管理页）
- **Cron 写入**：无
- **影响订单主链路**：间接
- **建议**：保留

### factories
- **分类**：✅ ACTIVE
- **代码引用**：12 处
- **UI 读取**：是（工厂管理页）
- **Cron 写入**：无
- **影响订单主链路**：间接
- **建议**：保留

### customer_rhythm
- **分类**：📥 PASSIVE
- **代码引用**：11 处
- **UI 读取**：无（/my-today 任务生成读取，但无独立 UI）
- **Cron 写入**：daily cron 每天同步（`syncAllCustomerRhythms`）
- **影响订单主链路**：否（客户管理辅助）
- **建议**：保留；后续添加客户详情页展示

### profit_snapshots
- **分类**：📥 PASSIVE
- **代码引用**：5 处
- **UI 读取**：无独立 UI（profit.service 写入，order_financials 页面只读部分字段）
- **Cron 写入**：无（服务层手动触发）
- **影响订单主链路**：否（利润辅助）
- **建议**：保留；已通过 quote-bridge 接入第一版快照

### daily_tasks
- **分类**：📥 PASSIVE
- **代码引用**：5 处
- **UI 读取**：是（/my-today 页面读取）
- **Cron 写入**：daily cron
- **影响订单主链路**：否
- **建议**：保留

### daily_briefings
- **分类**：📥 PASSIVE
- **代码引用**：5 处
- **UI 读取**：/briefing 页面（如有）
- **Cron 写入**：daily-briefing cron
- **影响订单主链路**：否
- **建议**：保留

### ai_skill_runs
- **分类**：📥 PASSIVE
- **代码引用**：8 处
- **UI 读取**：无
- **Cron 写入**：agent-scan（已禁用调度）、skills runner
- **影响订单主链路**：否
- **建议**：保留（审计追溯用途）

### ai_context_cache
- **分类**：📥 PASSIVE
- **代码引用**：3 处
- **UI 读取**：无
- **Cron 写入**：ai-context.service（按需写入）
- **影响订单主链路**：否
- **建议**：保留（AI 上下文缓存，TTL 自清）

### email_process_log
- **分类**：📥 PASSIVE
- **代码引用**：4 处
- **UI 读取**：/admin/mail-monitor（管理员）
- **Cron 写入**：email-scan cron
- **影响订单主链路**：否（邮件辅助）
- **建议**：保留

### order_logs
- **分类**：📥 PASSIVE
- **代码引用**：3 处
- **UI 读取**：无独立页面
- **Cron 写入**：无（服务层写入）
- **影响订单主链路**：否（操作追踪）
- **建议**：保留；quote-bridge 已开始写入

---

## 危险表（被已禁用 Cron 写入）

### system_health_reports
- **分类**：⚠️ DANGEROUS
- **代码引用**：4 处
- **UI 读取**：/admin/system-health 页面
- **Cron 写入**：nightly-maintenance（已禁用调度，autoFix=true 有副作用）
- **影响订单主链路**：否
- **建议**：nightly-maintenance 禁用后停止写入；UI 展示历史数据仍可用；后续替换为只读健康检查

### ai_learning_log
- **分类**：⚠️ DANGEROUS
- **代码引用**：0 处（无 UI 消费）
- **UI 读取**：无
- **Cron 写入**：ai-self-improve（已禁用）、agent-learn（已禁用调度）
- **影响订单主链路**：否
- **建议**：无需维护；待确认无数据后可归档

### compliance_findings
- **分类**：⚠️ DANGEROUS
- **代码引用**：5 处
- **UI 读取**：无独立 UI（可能有 admin 页面）
- **Cron 写入**：compliance-check（已禁用）
- **影响订单主链路**：否
- **建议**：compliance-check 禁用后停止写入；历史数据保留供审计参考

### alerts
- **分类**：📥 PASSIVE / ⚠️ DANGEROUS
- **代码引用**：1 处
- **UI 读取**：无
- **Cron 写入**：alerts.service（每日 daily cron 调用 resolveStaleAlerts）
- **影响订单主链路**：否
- **建议**：保留，但监控写入量

---

## 幽灵表 / 归档候选（GHOST / ARCHIVE_CANDIDATE）

### ai_collection_log
- **分类**：👻 GHOST
- **代码引用**：2 处（仅 ai-self-improve，已禁用）
- **UI 读取**：无
- **Cron 写入**：ai-self-improve（已禁用）
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE — 确认无数据后可删除

### order_model_analytics
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：不详
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE — 需确认是否有数据

### order_sequences
- **分类**：👻 GHOST
- **代码引用**：0 处（代码已不引用）
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE — 确认是否仍有触发器依赖

### tech_scout_reports
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：tech-scout（已禁用）
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### ai_self_improve_log
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：ai-self-improve（已禁用）
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### schedule_anchors / schedule_deviations
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：确认是否有 lib/constants/schedule-anchors.ts 的数据库依赖

### knowledge_graph_nodes / knowledge_graph_edges
- **分类**：👻 GHOST
- **代码引用**：0 处（lib/agent/knowledgeGraph.ts 存在但未使用）
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### order_embeddings
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### order_communication_logs
- **分类**：👻 GHOST
- **代码引用**：0 处（lib/agent/orderCommunicationLog.ts 存在但 UI 未消费）
- **UI 读取**：无
- **Cron 写入**：email-scan 可能写入
- **影响订单主链路**：否
- **建议**：确认数据量后决定保留/归档

### agent_suggestions
- **分类**：👻 GHOST
- **代码引用**：0 处（表名）
- **UI 读取**：无（agent_actions 表已替代）
- **Cron 写入**：无（已被 agent_actions 替代）
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE（确认与 agent_actions 是否重复）

### email_uid_dedup / email_archive
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：不详
- **影响订单主链路**：否
- **建议**：确认是否与 email_process_log 重复

### cost_monitoring_alerts
- **分类**：👻 GHOST
- **代码引用**：0 处（cost-monitoring cron 直接写 notifications）
- **UI 读取**：无
- **Cron 写入**：无（实际写 notifications 表）
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE — 如果从未写入可删

### shipping_bookings
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否（物流节点用 milestones + attachments）
- **建议**：📦 ARCHIVE_CANDIDATE

### qc_reports
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无（QC 凭证通过 order_attachments 管理）
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### production_orders / payment_records / warehouse_items
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE — 确认是否为历史遗留表

### customer_contacts / customer_followups
- **分类**：👻 GHOST
- **代码引用**：0 处
- **UI 读取**：无（客户跟进通过 customer_rhythm + daily_tasks 管理）
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：📦 ARCHIVE_CANDIDATE

### procurement_orders
- **分类**：👻 GHOST
- **代码引用**：0 处（使用 procurement_line_items）
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否
- **建议**：确认是否为 procurement_line_items 的父表

### milestone_templates
- **分类**：👻 GHOST
- **代码引用**：0 处（模板逻辑在 lib/milestoneTemplate.ts 代码中，不在 DB）
- **UI 读取**：无
- **Cron 写入**：无
- **影响订单主链路**：否（运行时生成）
- **建议**：确认是否有存量数据

---

## 优先关注清单

### 🔴 立即确认（可能有隐患）

| 表 | 问题 |
|----|------|
| `milestones.owner_user_id` | proactive-fix 禁用后新订单节点无人自动分配，需要人工处理或 UI 优化 |
| `system_health_reports` | nightly-maintenance 禁用后停止更新，admin/system-health 页面数据会停滞 |
| `compliance_findings` | 无人消费，历史数据可能误导 |

### 🟡 下阶段处理（归档候选）

优先归档：
1. `tech_scout_reports` — 完全与业务无关
2. `ai_self_improve_log` / `ai_learning_log` — 伪功能产物  
3. `ai_collection_log` — 同上
4. `order_embeddings` / `knowledge_graph_*` — 从未生产使用

**归档前必须操作**：
1. `SELECT COUNT(*) FROM <table>` 确认是否有数据
2. 如有数据，`pg_dump` 导出备份
3. 不直接 DROP，先 `ALTER TABLE xxx RENAME TO xxx_archived_20260427`

---

## 统计汇总

| 分类 | 数量 |
|------|------|
| ✅ ACTIVE | 15 |
| 📥 PASSIVE | 8 |
| ⚠️ DANGEROUS | 4 |
| 👻 GHOST / 📦 ARCHIVE_CANDIDATE | 约 20+ |

> **注意**：此审计基于代码静态分析，实际表是否存在、是否有数据，需在 Supabase SQL Editor 运行 `SELECT table_name, (SELECT COUNT(*) FROM information_schema.tables WHERE table_name=t.table_name) FROM information_schema.tables t WHERE table_schema='public'` 确认。
