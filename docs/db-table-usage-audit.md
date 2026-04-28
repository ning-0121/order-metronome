# 数据库表使用审计

> 生成时间：2026-04-27（v1/v2）→ 2026-04-28（v3 全量补全）  
> 审计工具：代码 grep 引用统计 + Cron 写入分析 + Supabase 实际行数验证 + migrations 全量比对  
> 版本：System Consolidation Sprint v3（**已扩展到 migrations 定义的全部 73 张表**）

---

## ⚠️ 第二阶段修正声明（2026-04-27 晚）

通过 Supabase SQL Editor 实际查询，发现 v1 审计文档存在**误报**：

### 修正一：`order_sequences` 不是 GHOST，是关键基础设施
- 实际 16 行数据，在用
- 通过 PG 函数 `generate_order_sequence()` 被 `lib/repositories/ordersRepo.ts` RPC 调用
- Migration 注释明确：`⚠️ CRITICAL: This table should NEVER be deleted or rolled back`
- **重新分类为 ✅ ACTIVE，永久保留**

### 修正二：以下 23 张表**从未在生产创建过**，v1 误判为 GHOST，应从审计移除

```
agent_suggestions, ai_learning_log, ai_self_improve_log, alerts,
cost_monitoring_alerts, customer_contacts, customer_followups,
email_archive, email_uid_dedup, knowledge_graph_edges, knowledge_graph_nodes,
milestone_templates, order_communication_logs, order_embeddings,
payment_records, procurement_orders, production_orders, qc_reports,
schedule_anchors, schedule_deviations, shipping_bookings,
tech_scout_reports, warehouse_items
```

> 这些表是历史 prompt 提到但从未实际建表。`alerts` 一项是命名错误：实际表是 `system_alerts`（已存在但 0 行）。

### 修正三：4 张可冻结归档候选的真实状态

| 表 | 实际行数 | 写入源 | 处理 |
|----|---------|--------|------|
| `ai_collection_log` | 6 | ai-self-improve（已禁用） | 冻结写入，保留历史 |
| `compliance_findings` | 39 | compliance-check（已禁用） | 冻结写入，保留历史 |
| `system_health_reports` | 19 | nightly-maintenance（已禁用） | 冻结写入，保留历史 |
| ~~`order_model_analytics`~~ | ~~0~~ | 无 | ✅ **2026-04-27 已归档** → `order_model_analytics_archived_20260427` |

### 已执行的 DB 操作日志

| 日期 | 操作 | 详情 | 回滚命令 |
|------|------|------|----------|
| 2026-04-27 | RENAME 归档 | `order_model_analytics` → `order_model_analytics_archived_20260427` | `ALTER TABLE order_model_analytics_archived_20260427 RENAME TO order_model_analytics;` |

---

## ⚠️ 第三阶段补全（2026-04-28，Phase 1 入口审计）

**v2 覆盖局限**：v2 详述了 ~35 张表，但 migrations 全量扫描显示有 73 张表（`grep "create table" supabase/migration.sql supabase/migrations/*.sql`）。本次 v3 把 **从未在 v1/v2 出现过的 38 张表**全部补齐，并加入两项关键新发现。

### v3 关键新发现

#### 发现 #1：`lib/services/quote-bridge.service.ts` 是孤儿代码

- 文件存在（268 行）实现 `convertQuoteToOrderFinancials(quoteId, orderId)` —— 报价→财务→利润完整数据流
- **代码引用：0** 处（grep `convertQuoteToOrderFinancials` 与 `quote-bridge` 在 app/components 全部命中为零）
- 已生成的能力但**没有任何 UI / action / cron 调用它**
- 影响：v2 审计声称 quoter_quotes "已通过 quote-bridge 打通报价数据流" — 这个说法**事实上不成立**
- 处理建议：保留代码，留待 Phase 2 接入；不要 archive，否则要白做一遍

#### 发现 #2：`lib/ai/aiGateway.ts` 已存在但只覆盖 2 个调用方

- 200 行，已实现 task / cacheKey / shadowMode / featureFlag / auditLog
- 当前调用方：`app/actions/quoter-training.ts`, `lib/services/briefing.service.ts`（共 2 处）
- 其他 AI 调用仍直接走 `lib/agent/anthropicClient.ts`（`callClaude` / `callClaudeJSON`）—— 18 处以上
- 处理建议：保留，Phase 2 渐进迁移

#### 发现 #3：profit_snapshots 写入路径完全断链

- `profit_snapshots` 表存在（migration 20260427_trade_os_foundation.sql 创建）
- **唯一写入点**：`lib/services/quote-bridge.service.ts`（孤儿）+ `lib/services/profit.service.ts`（被服务层引用，但**实际触发条件未连入 UI**）
- 结果：表存在但**生产环境几乎不会有数据**，是**逻辑层 GHOST**
- v2 标记其"已通过 quote-bridge 接入第一版快照"也是事实上不成立

---

### v3 全量索引（73 张表）

> 数据来源：`supabase/migrations/*.sql` + `supabase/migration.sql` 全量扫描  
> 引用计数来源：`grep "from\(['\"]TABLE['\"]\)"` 在 `app/` + `lib/` 下统计  
> 写入次数 = `.insert/.update/.upsert/.delete` 调用数量  
> Cron写入 = 上述写入中位于 `app/api/cron/` 下的数量  
> UI 读取 = 在 `*.tsx` 文件中出现的引用文件数

| 分类 | 表名 | 总引用 | 写入 | Cron写 | UI读 | v1/v2已覆盖 |
|---|---|---|---|---|---|---|
| ✅ ACTIVE | orders | 85 | 1 | 0 | 10 | ✓ |
| ✅ ACTIVE | profiles | 74 | 1 | 0 | 15 | ✓ |
| ✅ ACTIVE | milestones | 70 | 4 | 0 | 11 | ✓ |
| ✅ ACTIVE | notifications | 31 | 50 | **23** | 0 | ✓ |
| ✅ ACTIVE | delay_requests | 22 | 1 | 0 | 5 | ✓ |
| ✅ ACTIVE | mail_inbox | **20** | 4 | 2 | 0 | **✗ 待补** |
| ✅ ACTIVE | customer_memory | **20** | 12 | 2 | 1 | **✗ 待补** |
| ✅ ACTIVE | milestone_logs | 18 | 19 | 0 | 2 | ✓ |
| ✅ ACTIVE | order_attachments | 15 | 3 | 0 | 7 | ✓ |
| ✅ ACTIVE | agent_actions | 12 | 10 | 6 | 1 | ✓ |
| ✅ ACTIVE | order_financials | 11 | 2 | 0 | 0 | ✓ |
| ✅ ACTIVE | factories | 10 | 0 | 0 | 3 | ✓ |
| ✅ ACTIVE | order_cost_baseline | 9 | 2 | 0 | 0 | ✓ |
| ✅ ACTIVE | order_confirmations | **8** | 2 | 0 | 0 | **✗ 待补**（关键：blockRules 依赖） |
| 📥 PASSIVE | customers | 5 | 0 | 0 | 0 | ✓ |
| 📥 PASSIVE | ai_knowledge_base | **5** | 9 | 1 | 0 | **✗ 待补** |
| 📥 PASSIVE | daily_briefings | 5 | 2 | 2 | 0 | ✓ |
| 📥 PASSIVE | production_reports | **5** | 2 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | order_retrospectives | **4** | 0 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | cancel_requests | **4** | 0 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | customer_rhythm | 4 | 0 | 0 | 0 | ✓ |
| 📥 PASSIVE | email_order_diffs | **4** | 1 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | pre_order_price_approvals | **4** | 0 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | procurement_line_items | 4 | 2 | 0 | 0 | ✓ |
| 📥 PASSIVE | user_memos | **4** | 1 | 0 | 2 | **✗ 待补** |
| 📥 PASSIVE | order_logs | 3 | 3 | 0 | 1 | ✓ |
| 📥 PASSIVE | system_alerts | 3 | 0 | 0 | 0 | ✓ |
| 📥 PASSIVE | system_health_reports | 3 | 0 | 0 | 1 | ✓ |
| 📥 PASSIVE | profit_snapshots | 3 | 0 | 0 | 0 | ✓ |
| 📥 PASSIVE | quoter_quotes | 3 | 1 | 0 | 1 | ✓ |
| 📥 PASSIVE | compliance_findings | 3 | 1 | 0 | 0 | ✓ |
| 📥 PASSIVE | procurement_tracking | **3** | 2 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | quoter_cmt_training_samples | 3 | 2 | 0 | 0 | ✓ |
| 📥 PASSIVE | shipment_confirmations | **2** | 3 | 0 | 1 | **✗ 待补** |
| 📥 PASSIVE | order_amendments | **2** | 2 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | order_root_causes | **2** | 1 | 0 | 0 | **✗ 待补**（最近新建） |
| 📥 PASSIVE | order_commissions | **2** | 2 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | packing_lists | **2** | 0 | 0 | 1 | **✗ 待补** |
| 📥 PASSIVE | document_extractions | **2** | 0 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | quoter_training_feedback | **2** | 1 | 0 | 1 | **✗ 待补** |
| 📥 PASSIVE | quoter_fabric_records | **2** | 1 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | customer_email_domains | **2** | 4 | 0 | 0 | **✗ 待补** |
| 📥 PASSIVE | ai_skill_runs | 2 | 0 | 0 | 0 | ✓ |
| 📥 PASSIVE | ai_skill_circuit_state | **2** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | ai_collection_log | 1 | 1 | 0 | 0 | ✓ |
| 👻 GHOST | ai_context_cache | 1 | 0 | 0 | 0 | ✓ |
| 👻 GHOST | attachments | **1** | 0 | 0 | 0 | **✗ 待补**（被 order_attachments 取代） |
| 👻 GHOST | agent_batch_jobs | **1** | 1 | 1 | 0 | **✗ 待补** |
| 👻 GHOST | company_profile | **1** | 1 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | daily_tasks | 1 | 0 | 0 | 0 | ✓ |
| 👻 GHOST | email_process_log | 1 | 0 | 0 | 0 | ✓ |
| 👻 GHOST | issue_slips | **1** | 0 | 0 | 1 | **✗ 待补** |
| 👻 GHOST | mail_inbox（重复） | — | — | — | — | — |
| 👻 GHOST | materials_bom | **1** | 2 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | order_notes_log | **1** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | order_templates | **1** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | outsource_jobs | **1** | 2 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | packing_list_lines | **1** | 2 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | procurement_shared_sheets | **1** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | procurement_sheet_items | **1** | 1 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | qc_inspections | **1** | 2 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | shipment_batches | **1** | 1 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | system_kv | **1** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | order_sequences | 0 | 0 | 0 | 0 | ✓（v2: ACTIVE，PG 函数依赖） |
| 👻 GHOST | ai_learning_log | **0** | 0 | 0 | 0 | v2: 不存在于 DB |
| 👻 GHOST | ai_skill_actions | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | company_settings | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | cost_reconciliations | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | customer_analytics | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | exceptions | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | factory_analytics | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | issue_slip_lines | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | order_model_analytics | 0 | 0 | 0 | 0 | v2 已 RENAME 归档 |
| 👻 GHOST | quoter_cmt_operations | **0** | 0 | 0 | 0 | **✗ 待补** |
| 👻 GHOST | quoter_cmt_rates | **0** | 0 | 0 | 0 | **✗ 待补** |

**统计**：73 张表 / v1+v2 详述 35 张 / **本轮 v3 新增 38 张**。

---

### v3 详述：v1/v2 未覆盖的 38 张表

#### 主链路活跃但 v2 漏写

##### mail_inbox
- **分类**：✅ ACTIVE
- **代码引用**：20 处
- **UI 读取**：admin/mail-monitor、订单详情邮件 tab
- **Cron 写入**：email-scan、email-backfill（每 15 分钟+每日 17:40）
- **影响订单主链路**：是（邮件→订单匹配核心）
- **建议**：保留；这是 v2 漏掉的高活跃表

##### customer_memory
- **分类**：✅ ACTIVE
- **代码引用**：20 处
- **UI 读取**：客户详情、风险评估
- **Cron 写入**：email-scan（写入 type='email_summary'）
- **影响订单主链路**：是（风险评估读取）
- **建议**：保留；与 customer_rhythm 数据互补，不冲突

##### order_confirmations
- **分类**：✅ ACTIVE（关键）
- **代码引用**：8 处
- **UI 读取**：订单详情确认链 tab
- **Cron 写入**：无
- **影响订单主链路**：**是（blockRules.ts 强依赖：fabric_color/size_breakdown/logo_print/packaging_label 阻塞 milestone）**
- **建议**：保留；任何变更需同步更新 blockRules.ts

##### order_root_causes
- **分类**：✅ ACTIVE（新建）
- **代码引用**：2 处（rootCauseEngine + causeRules）
- **UI 读取**：无（暂未上 UI）
- **Cron 写入**：无（rootCauseEngine 按需写入）
- **影响订单主链路**：是（决策引擎依据）
- **建议**：保留；Phase 2 在订单详情加 root cause panel；cause_code 已枚举但 reason_text 仍允许自由文本，待 Phase 1 做枚举强制

##### ai_knowledge_base
- **分类**：📥 PASSIVE（值得升级 ACTIVE）
- **代码引用**：5 处（actions/ai-knowledge.ts）
- **UI 读取**：admin/ai-knowledge 页
- **Cron 写入**：1 处（来源不详，可能 agent-learn）
- **影响订单主链路**：否
- **建议**：保留；专业知识库支撑风险评估的 knowledge injection

##### production_reports
- **分类**：📥 PASSIVE
- **代码引用**：5 处
- **UI 读取**：订单详情生产 tab
- **Cron 写入**：无
- **影响订单主链路**：是（生产进度上报）
- **建议**：保留；defect_count 等字段是工厂能力画像的数据源

#### v2 漏写的次活跃表（PASSIVE）

| 表 | 引用 | 写 | UI | 备注 |
|---|---|---|---|---|
| order_amendments | 2 | 2 | 0 | 客户改单记录 → 客户行为画像数据源 |
| order_retrospectives | 4 | 0 | 0 | 复盘表，写入逻辑不清楚需查 |
| cancel_requests | 4 | 0 | 0 | 4 处引用但 0 写入 → 可能是 UI 读未连写入路径 |
| email_order_diffs | 4 | 1 | 0 | 邮件检测的字段差异 → 客户改单频率派生 |
| pre_order_price_approvals | 4 | 0 | 0 | 价格闸门审批；写入路径需查（可能在 UI tsx 内联） |
| procurement_tracking | 3 | 2 | 0 | 采购跟踪 |
| order_commissions | 2 | 2 | 0 | 佣金记录 |
| order_logs | 3 | 3 | 1 | 操作日志（quote-bridge 计划写入但未连） |
| customer_email_domains | 2 | 4 | 0 | 客户邮箱域名映射；写入仅在 actions/customer-emails.ts |
| document_extractions | 2 | 0 | 0 | 0 写入但 2 引用 → 可能是历史 PO 解析中间表 |
| materials_bom | 1 | 2 | 0 | 物料 BOM；可能与 procurement_line_items 重叠 |
| outsource_jobs | 1 | 2 | 0 | 外发记录；用户提及"外发异常"画像数据源 |
| packing_lists / packing_list_lines | 1+2 | 0+2 | 1+0 | 装箱单（拆装明细）；出货安全 block 规则的潜在依据 |
| qc_inspections | 1 | 2 | 0 | QC 记录；与 v2 标记的"qc_reports 不存在"不冲突，这是另一张表 |
| quoter_training_feedback | 2 | 1 | 1 | 报价员训练反馈 |
| quoter_fabric_records | 2 | 1 | 0 | 报价面料记录 |
| shipment_batches | 1 | 1 | 0 | 分批出货 |
| shipment_confirmations | 2 | 3 | 1 | 出货确认 |
| user_memos | 4 | 1 | 2 | 个人便签 |
| issue_slips / issue_slip_lines | 1+0 | 0+0 | 1+0 | 出问题记录单；几乎无写入 → archive 候选 |
| ai_skill_circuit_state | 2 | 0 | 0 | 仅读未写 → 熔断状态从未真正触发？ |
| agent_batch_jobs | 1 | 1 | 0 | Anthropic Batch API 任务记录 |

#### v2 漏写的真正幽灵（GHOST，0 引用）

**全部 0 代码引用**，建议 Phase 2 评估归档：

- **attachments**（被 order_attachments 取代，1 处引用是历史代码）
- **company_profile** / **company_settings**（公司信息表，company_profile 1 写但无消费）
- **cost_reconciliations**（0 引用，从未使用）
- **customer_analytics** / **factory_analytics**（被 customer_rhythm / 计算属性取代）
- **exceptions**（0 引用，疑似异常上报历史表）
- **issue_slip_lines**（与 issue_slips 配对但未启用）
- **order_notes_log**（被 order_logs 取代）
- **order_templates**（订单模板，UI 有 admin/order-templates 但读取代码 0）
- **procurement_shared_sheets** / **procurement_sheet_items**（采购共享表，1 ref 但本质未启用）
- **quoter_cmt_operations** / **quoter_cmt_rates**（报价 CMT 表，0 引用，疑似规划阶段）
- **system_kv**（KV 存储抽象，0 实用引用）
- **ai_skill_actions**（0 引用，与 ai_skill_runs / agent_actions 重叠）

> **提醒**：Phase 1 不允许删表，仅做记录。归档评估留到 Phase 2，且必须先 `SELECT COUNT(*)` 确认无生产数据。

---

### 报价 → 订单 → 利润 数据流断点分析

> 用户在 Phase 1 范围里明确要求"必须把 quoter_quotes、order_financials、profit_snapshots 的断点写清楚"。

#### 三表当前状态

| 表 | 行数提示 | 主要写入 | 主要读取 | 状态 |
|---|---|---|---|---|
| `quoter_quotes` | 报价员日常使用 | `app/actions/quoter.ts` | 报价员页面、订单关联（理论上） | ACTIVE |
| `order_financials` | 订单详情有数据 | `app/actions/order-financials.ts`、`app/actions/order-business-state.ts` | 订单详情经营数据、`riskAssessment.ts`、`pending-approvals.service` | ACTIVE |
| `profit_snapshots` | 几乎为空 | **仅** `quote-bridge.service.ts`（孤儿）+ `profit.service.ts` | `daily-tasks.service` 读取（如果有 snapshot） | **逻辑层 GHOST** |

#### 数据流应该长什么样（设计意图）

```
quoter 报价员定单价/成本/利润率 → quoter_quotes
       ↓
   订单创建时 把报价 ID 传入
       ↓
   convertQuoteToOrderFinancials(quoteId, orderId)
       ↓
   写入/更新 order_financials（含 quote 来源 ID）
       ↓
   生成第一版 profit_snapshot（当下利润假设）
       ↓
   订单执行过程中 实际成本/汇率/费用变化 → 追加新 profit_snapshot
       ↓
   完成后 sealProfitSnapshot 锁死最终利润
```

#### 实际断点（按严重度）

**断点 1：quoter_quotes 与 orders 之间没有外键**
- `quoter_quotes` 没有 `linked_order_id` 字段
- `orders` 没有 `source_quote_id` 字段
- 即便有 `quote-bridge` 服务也不知道哪个 quote 对应哪个 order
- **修复成本**：低（加 1 列 + admin 手动绑定）
- **风险**：无，nullable 字段不影响主流程

**断点 2：quote-bridge 服务孤儿**
- 文件存在 268 行，0 调用
- 对应的 admin 触发 UI 没建
- **修复成本**：低（加一个 admin 页面，手动选 quote 和 order，触发 convert）
- **风险**：低，服务内部已自带"数据不完整时返回 missing fields 不静默失败"

**断点 3：profit_snapshots 没有自动触发节点**
- 现有代码只在 quote-bridge 触发时写一次
- 订单执行过程中实际成本变化（采购实付、QC 返工费、出货运费）不会自动触发新 snapshot
- 当前 `profit.service.ts` 有计算函数但**没有 cron 或 event hook 调用它**
- **修复成本**：中（需定义触发时机：cost_baseline 修改？支付到账？里程碑完成？）
- **风险**：低（feature flag 包住）

**断点 4：order_financials 字段与 quoter_quotes 字段不对齐**
- `quoter_quotes` 有：unit_price, total_amount, fabric_cost, cmt_cost, profit_margin
- `order_financials` 有：quote_amount, deposit_amount, balance_amount, margin_pct
- **fabric_cost / cmt_cost 在 order_financials 中没有对应字段**，convert 时只能聚合到 cost_total 之类
- **修复成本**：中（要么扩展 order_financials，要么在 order_cost_baseline 中存储分项）
- 当前 `order_cost_baseline` 表本来就该承担这个角色（保存细分成本基线），但 quote-bridge 没写它
- **正确链路应该是**：quote → cost_baseline（细分） + financials（汇总） + profit_snapshot（瞬时利润）

#### Phase 2 修复清单（不在 Phase 1 范围）

1. `orders` 加 `source_quote_id uuid REFERENCES quoter_quotes(id) NULL`
2. 新建 admin 页 `/admin/quote-bridge`，可手动选 quote+order 触发 convert
3. quote-bridge 服务内部调整：同时写 order_cost_baseline（细分成本）+ order_financials（汇总）+ profit_snapshots
4. 后续在订单执行节点（cost_baseline 修改、payment 入账）触发新 snapshot
5. 利润趋势图（profit_snapshots 时序数据）做进订单详情经营 tab

---

### v3 重点关注清单更新

#### 🔴 立即确认（事实修正）

| 表 | v2 说法 | v3 修正 |
|---|---|---|
| `profit_snapshots` | "已通过 quote-bridge 接入第一版快照" | **事实上不成立**：quote-bridge 是孤儿，profit_snapshots 几乎为空 |
| `order_logs` | "quote-bridge 已开始写入" | **事实上不成立**：同上 |
| `quoter_quotes` | "quote-bridge 已建立到 order_financials 的数据流" | **数据流代码存在但无入口**，事实链路为 0 |

#### 🟡 Phase 1 数据采集 OK 推进的依据

通过 v3 全量审计，下面 4 张 Phase 1 计划新建的表**与现有表无重复**：

- `customer_behavior_profile` — 与 customer_memory（事件表）、customer_rhythm（节奏跟进）互补，是计算后的画像
- `factory_capability_profile` — 与 factories（基础信息）、factory_analytics（已 GHOST）不冲突
- `agent_action_feedback` — 全新概念，无重叠
- `admin_overrides` — 全新概念，无重叠

#### 🟢 Phase 1 不需要 touch 的表（保护清单）

| 表 | 原因 |
|---|---|
| orders / milestones / profiles / order_attachments | 主链路核心，绝对不动 |
| order_confirmations | blockRules 硬依赖，结构不动 |
| order_sequences | PG 函数依赖，永久保留 |
| 18 个 cron 写入表 | Phase 1 不动任何 cron |

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

## 统计汇总（v3 修正）

| 分类 | v2 数量 | v3 全量数量 | 备注 |
|------|------|------|------|
| ✅ ACTIVE | 15 | **15**（其中 6 张是 v3 补充：mail_inbox / customer_memory / order_confirmations / order_root_causes / production_reports / ai_knowledge_base） | 主链路 / 阻塞规则 / 数据采集核心 |
| 📥 PASSIVE | 8 | **30** | v3 补足了 22 张次活跃表 |
| ⚠️ DANGEROUS | 4 | **4** | system_health_reports / ai_learning_log / compliance_findings / alerts（v2 列出，状态不变） |
| 👻 GHOST | 约 20 | **24** | 其中 14 张是 0 引用真幽灵 |
| **migrations 总数** | — | **73** | 来自 `supabase/migration.sql` + `supabase/migrations/*.sql` |

**v3 重要更新**：
1. v2 标记为"已通过 quote-bridge 打通"的报价数据流，**事实上是孤儿代码（0 调用方）**
2. `profit_snapshots` 实际是逻辑层 GHOST，需 Phase 2 修复
3. `lib/ai/aiGateway.ts` 已存在但仅覆盖 2 个调用点，其余 AI 调用仍直接走 anthropicClient
4. v1/v2 详述 35 张表，**v3 补全 38 张**未覆盖表

> **注意**：此审计基于代码静态分析，实际表是否存在、是否有数据，需在 Supabase SQL Editor 运行  
> ```sql
> SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int AS row_count
> FROM information_schema.tables WHERE table_schema='public' ORDER BY row_count DESC;
> ```
> 该查询会返回每张表的实际行数，配合本文 v3 索引表使用即可验证。
