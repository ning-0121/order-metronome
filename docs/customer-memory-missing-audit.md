# customer_memory 缺表审计（P0）— Missing Table Audit

> 性质：审计 + 修复记录。审计于 2026-06-12 完成；**R1 补建表 + R4 同类排查已于同日执行完毕**（见 §7 执行记录）。
> 代码侧零改动（28 处引用未动，本来就无需动 —— 补表即恢复）。

---

## 1. 已确认事实

- **`public.customer_memory` 表在生产库不存在**：SQL Editor 实测 `ERROR 42P01: relation "public.customer_memory" does not exist`（2026-06-11）。
- 迁移文件**完整存在**且从未在生产执行：
  - `supabase/migrations/20240125000000_add_customer_memory.sql`（建表 + 3 索引 + RLS）
  - `supabase/migrations/20240126000000_mail_inbox_and_customer_memory_mail.sql`（`created_by` 放宽可空 + 加 `content_json`；其 mail_inbox 部分生产已有，幂等无害）
- **列定义与代码写入逐列核对一致**（customer_id / order_id / source_type / content / category / risk_level / created_by / content_json）→ **补建表即可完整恢复，无需改任何代码**。
- 丢失原因推测：2026-05-23 force-push 回滚事故（"76 模块缺失"）后重建生产库时，consolidated `migration.sql` 不含此表，两个独立迁移也未重放。
- 同病根案例：`customer_rhythm` 长期空表（幽灵列 bug）、`sample_status` 死列 —— 均为「代码引用的对象在生产缺失/失效 + 错误被吞」模式。

---

## 2. 影响范围：28 处引用（12 写 + 16 读），全部静默失效

### 2.1 写入路径（12 处）— insert 全部失败

| 位置 | 场景 | 失败表现 |
|---|---|---|
| `app/actions/customer-memory.ts:25` | 客户页「添加经验备忘」表单 | **用户可见报错**（error 返回表单） |
| `app/api/cron/email-scan/route.ts:382` | 邮件 AI 分析写记忆（email_ai） | 静默丢失 |
| `lib/agent/orderCommunicationLog.ts:111` | 邮件沟通分类（complaint/sample/general） | 静默丢失 — **CEO 客户事项原定投诉数据源**，因此改用 mail_inbox 关键词 |
| `app/actions/milestones.ts:994` | repeated_blocked 客户重复阻塞告警 | 机制从未生效 |
| `app/actions/delays.ts:203, 467` | 延期相关客户记忆（2 处） | 静默丢失 |
| `app/actions/orders.ts:687` | 翻单问题记录（repeat_issues） | 静默丢失 |
| `app/actions/mail-inbox.ts:96` / `app/api/mail-inbox/route.ts:105` | 邮件入库写记忆（2 处） | 静默丢失 |
| `app/api/cron/agent-scan/route.ts:568` | Agent 扫描写记忆 | 静默丢失 |
| `lib/agent/multiStepReasoning.ts:129` | 多步推理结论沉淀 | 静默丢失 |
| `lib/agent/emailLearning.ts:93` | 邮件学习写记忆 | 静默丢失 |

### 2.2 读取路径（16 处）— select 报错被吞，返回空

| 位置 | 场景 | 用户可见影响 |
|---|---|---|
| `app/customers/page.tsx:85` | 客户页「客户档案备忘」 | **永远显示 0 条**（截图已证实） |
| `app/actions/customer-memory.ts:49` | 备忘列表 | 空 |
| `lib/agent/skills/riskAssessment.ts:1234, 1240` | 风险评估的投诉/质量计数（2 处） | AI 风险评分缺投诉维度 |
| `app/actions/smart-insights.ts:39, 310` | 智能洞察（2 处） | 缺客户经验维度 |
| `app/actions/agent-chat.ts:58, 141` | Agent 对话上下文（2 处） | 同上 |
| `lib/agent/aiEnhance.ts:212` / `knowledgeGraph.ts:98` / `emailOrderCompare.ts:72` / `complianceCheck.ts:63` / `emailLearning.ts:127` | AI 上下文族（5 处） | 同上 |
| `app/actions/ai-knowledge.ts:166` | AI 知识页 | 空 |
| `app/api/cron/agent-scan/route.ts:560` | Agent 扫描读 | 空 |
| `lib/services/order-decision-context.service.ts:86` | 订单决策上下文 | 缺维度 |

---

## 3. 修复安全性评估

- **补建表 = 依次执行两个现成迁移**（20240125 → 20240126），均幂等（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），**零代码改动**，对现有功能零风险。
- 执行后：12 处写入立即开始累积新数据；16 处读取立即恢复（从空表开始）。

## 4. 回填评估

| 数据类 | 可否回溯 |
|---|---|
| 邮件类（email_ai / 沟通分类 / 邮件学习） | **部分可**：历史邮件仍在 mail_inbox（2074 封），可经 `/api/mail-reprocess` 或 email-backfill 重处理，但**消耗 AI token**，需单独评估成本再决定 |
| 人工备忘 / repeated_blocked / 延期记忆 / 翻单记录 | **不可回溯**（事件已过，只能新数据累积） |

→ 建议：先补表让新数据累积，回填作为可选项单独拍板。

## 5. 修复建议（按优先级，待拍板）

| 优先级 | 动作 | 成本 |
|---|---|---|
| **R1（建议立即）** | SQL Editor 依次执行 `20240125000000_add_customer_memory.sql` → `20240126000000_mail_inbox_and_customer_memory_mail.sql` | 2 次粘贴执行，零代码 |
| R2（可选） | 历史邮件重处理回填（评估 token 成本后再定） | 中 |
| R3（建议跟进） | 读取点吞错治理：至少给 `app/customers/page.tsx:85` 等高频读取加 error 日志（同 customer_rhythm 修法） | 小 |
| R4（建议跟进） | **同类缺表全面排查**：代码引用 74 张表 vs 生产 information_schema 比对（SQL 见 §6），防止还有第三张缺失表 |

## 6. 同类排查 SQL（只读，§5-R4 用）

```sql
-- 代码引用但生产缺失的表（期望仅 customer_memory；若有更多 → 同批补）
select t.tbl as code_referenced_but_missing
from unnest(array[
  'agent_actions','agent_batch_jobs','ai_collection_log','ai_context_cache','ai_knowledge_base',
  'ai_skill_circuit_state','ai_skill_runs','ai_usage_log','attachments','backups','cancel_requests',
  'company_profile','compliance_findings','customer_email_domains','customer_matters','customer_memory',
  'customer_rhythm','customer_sales_targets','customer_trim_library','customers','daily_briefings',
  'daily_tasks','decision_feedback','delay_requests','document_extractions','document_logs',
  'email_order_diffs','email_process_log','factories','issue_slips','mail_inbox','materials_bom',
  'milestone_logs','milestones','notifications','order_amendments','order_attachments',
  'order_commissions','order_confirmations','order_cost_baseline','order_decision_reviews',
  'order_documents','order_financials','order_logs','order_notes_log','order_outcome_reviews',
  'order_retrospectives','order_root_causes','order_templates','orders','outsource_jobs',
  'packing_list_lines','packing_lists','po_parse_drafts','pre_order_price_approvals',
  'procurement_line_items','procurement_shared_sheets','procurement_sheet_items','procurement_tracking',
  'production_reports','profiles','profit_snapshots','qc_inspections','quoter_cmt_training_samples',
  'quoter_fabric_records','quoter_quotes','quoter_training_feedback','runtime_events','runtime_orders',
  'shipment_batches','shipment_confirmations','system_alerts','system_health_reports','system_kv','user_memos'
]) as t(tbl)
where not exists (
  select 1 from information_schema.tables i
  where i.table_schema = 'public' and i.table_name = t.tbl
)
order by 1;
```

---

## 7. 执行记录（2026-06-12）

| 项 | 结果 |
|---|---|
| **R1 补建表** | ✅ 已执行：SQL Editor 跑 `20240125`（建表+索引+RLS）+ `20240126` 的 customer_memory 段（`created_by` 放宽可空 + `content_json`；mail_inbox 段跳过——生产已有，重跑会撞 policy 冲突）。验证 `count(*)=0` 成功返回（表已存在，空表起步） |
| **R4 同类排查** | ✅ 已执行：§6 比对 SQL 仅返回 1 行 `backups` —— **核查为误报**：`app/api/backup/route.ts` 三处均为 `supabase.storage.from('backups')`（Storage bucket，非数据库表），表清单正则未区分 Storage API。**真实缺表数 = 0，生产 schema 与代码已对齐** |
| R2 回填 | 未执行（可选项，邮件类重处理需评估 AI token 成本后单独拍板） |
| R3 吞错治理 | 未执行（建议跟进：高频读取点加 error 日志，同 customer_rhythm 修法） |

待办尾巴：
- ② 的微验证未见回执（`created_by is_nullable=YES` + `content_json` 列存在）。若 email-scan 写入仍失败，优先复查这两项。
- `backups` Storage bucket 是否真实存在未验（每日 18:00 备份 cron 依赖；缺失时路由会返回明确错误提示，可在 Supabase Dashboard → Storage 顺手确认）。

*经验沉淀：表名扫描正则 `\.from\('x'\)` 会把 Storage bucket 误计为表，后续排查需排除 `storage.from`。*
