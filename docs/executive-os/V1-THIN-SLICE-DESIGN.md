# V1 Delegation Loop — 收缩修正版设计(Thin Slice,2026-08-09)

> 应 CEO 三项收缩:①最薄端到端纵切 ②Voice 缓做(text-first)③ERD 严禁双真相源。
> 本文是"第一实施门"设计,**不建表、不编码**,停在此版待批。

## ⚠️ 前提纠正(实施前必须先说清)

CEO 收缩指令基于一个前提:"现有系统已有 tasks / task_runs / task_reviews / decision_logs /
execution_logs / outcome_logs,Executive OS 只做控制层去复用它们"。

**生产实查(2026-08-09,service-role):这六张表一张都不存在。** 现有可承接的只有:
- `daily_tasks`(5586 行)—— 唯一的任务载体,但 **task_type 是封闭 CHECK(全系统自动生成类型)、
  task_date=生成日非截止、status 仅 pending/done/snoozed/dismissed、无 due_at/验收/提交-验证态**
- `agent_actions`(订单绑定,9 类固定动作)、`order_logs`/`milestone_logs`(纯审计)

所以"复用现成任务/决策/验收体系"这个前提**不成立** —— 那套体系从来没建过。
这不改变收缩**原则**(不造双真相源),但改变**结论**:见 D 节的逐项论证。

## A. Revised Minimal ERD(2 新表 + 1 扩展,0 新任务/验收体系)

```
executive_captures          CEO 原始输入(每条一行) —— 新建(现无任何承接表)
  id, actor_user_id(CEO), source_type(text|voice|mail|file),
  raw_text, raw_audio_path(order-docs 桶,voice 第二步用), transcript,
  processing_status(captured|parsed|confirmed|discarded),
  captured_at
        │ 1
        ▼ N
executive_capture_items     AI 抽取的结构化草案 —— 新建(现无任何承接表)
  id, capture_id→executive_captures,
  item_type(fact|commitment|proposed_decision|proposed_task|reminder|risk|rule),
  structured_payload(jsonb), confidence numeric(3,2), source_span(text),
  linked_customer_id, linked_person, linked_order_id,
  confirmation_status(pending|confirmed|edited|rejected),
  spawned_task_id(→daily_tasks.id,确认后回填)
        │ proposed_task/confirmed
        ▼
daily_tasks(扩展,不新建)    确认后的委托任务落这里 —— 复用现有任务载体
  + task_type 增值 'ceo_delegation'(已是可扩 CHECK,20260722 迁移就在加类型)
  + due_at timestamptz             (现只有 task_date=生成日,缺真正截止)
  + acceptance_criteria text       (验收标准,缺)
  + delegation_status text         (delegated|in_progress|submitted|verifying|verified|rework|escalated)
  + verification_note text         (AI/人工核对结论)
  + capture_item_id uuid           (反查链:→ capture_item → capture → CEO 原话)
```

**为什么委托状态机不塞进 daily_tasks.status**:base `status`(pending/done/…)服务的是"每日待办"机械;
委托的"提交≠完成"生命周期(submitted→verifying→verified/rework)是另一套语义。用**独立列
`delegation_status`** 承载,不动 base status —— 是扩展一列,不是复制一套状态机表。

## B. Gregory Thin-Slice 时序

```
CEO ──"让欧璐准备Gregory当前项目新报价,明天下午前,利润<15%不要进入可发送状态"
 │  (文字输入,V1 first)
 ▼
[S1] executive_captures ← raw_text (safeMutation, processing_status=captured)
 ▼
[S2] AI 抽取(generateObject + 新 delegation-extract scene)
     → executive_capture_items:
        · proposed_task {owner:欧璐, action:准备报价, due:明天18:00, linked_person:Gregory}
        · rule {利润<15% → 不进入可发送状态}   ← RESTRICT,记为验收条件不是自动执行
     · Gregory 消歧:profiles/customers 模糊匹配 → linked_customer_id(tentative 标注)
 ▼
[确认卡] CEO Today 弹卡(复用 AgentSuggestionCard 范式)—— 30 秒:一句话+确认/改
 ▼
[S3] CEO 点确认 → safeCriticalMutation:
     · daily_tasks 插一行 task_type='ceo_delegation', assigned_to=欧璐,
       due_at=明天18:00, acceptance_criteria='利润≥15%才可进入可发送', delegation_status='delegated',
       capture_item_id=... ; capture_item.spawned_task_id 回填
     · writeAuditEvent(A2, decision_id=capture_id, actor=CEO) —— 反查链锚
     · insertNotifications → 欧璐
 ▼
[员工] 欧璐做完报价 → 点"提交" → delegation_status='submitted'(safeCriticalMutation)
 ▼
[S4] AI 核对:读该项目报价利润率 → 算 margin
        margin < 15% → delegation_status='rework' + verification_note + 通知欧璐(打回)
        margin ≥ 15% → delegation_status='verified'
     (verifier=ai 出结论;终态化守 RESTRICT:"进入可发送状态"是人工动作)
     逾期未提交 → 升级链(见 D:需扩 reminders 扫 daily_tasks.due_at)
 ▼
[S5] CEO Today「你委托的 / 已完成验证」区显示结果;点进去可反查到原始那句话
```

## C. 复用的现有表/函数(不重造)

| 用途 | 复用 |
|---|---|
| 写入安全 | `safeMutation` / `safeCriticalMutation`(断言+回读) |
| 审计+反查链 | `writeAuditEvent`(decision_id=capture_id,actor.on_behalf_of) |
| AI 抽取引擎 | `qimoAI.generateObject` + SchemaValidator 宽容校验 |
| 不确定性 | confidence numeric(3,2) + source_span(沿用全库约定) |
| 确认卡 UI | `AgentSuggestionCard`/`AgentSuggestionsPanel` 范式 |
| 任务载体 | `daily_tasks` + `upsertTask`(扩展,不新建) |
| 派发/升级/结果通知 | `insertNotifications` / `notifyUsersByRole` |
| 升级链 | `escalation-chain`(L1→L2→L3=CEO) |
| 文件本体 | order-docs 桶 + `uploadPoForParse` 直传 |
| CEO Today 聚合 | pending-approvals / 风险面板 / customer-matters(现成) |
| 实体消歧 | customers/factories/profiles 现有模糊匹配 |

## D. 真正必须新增 —— 逐项证明(严禁双真相源)

| 候选 | 判定 | 证明 |
|---|---|---|
| `executive_captures` | **必须新建** | CEO 原始输入无任何承接表。mail_inbox 是邮件专用+客户导向(from_email/extracted_po/order_id),塞不进"CEO 一句话"。document_extractions 是文档专用。 |
| `executive_capture_items` | **必须新建** | 一次输入→N 个待确认草案,每项独立确认+独立派生任务。现无任何"多实体草案待确认"表;jsonb 数组无法做逐项 confirmation_status + spawned_task 关联。 |
| ~~exec_delegations~~ | **不新建**,改扩 daily_tasks | daily_tasks 已是任务载体(assigned_to/title/desc/status)。缺的是 due_at/验收/委托状态 4 列 —— 扩列成立,建新表=复制任务系统(违规)。'ceo_delegation' 天然不被现有清理逻辑触及(markMilestoneDone 只清 milestone_overdue/due_today)。 |
| ~~exec_verifications~~ | **不新建** | 核对结论落 daily_tasks.verification_note + delegation_status;AI 核对过程事件走 writeAuditEvent。一条委托一个当前核对态,无需一对多表。 |
| ~~decision/outcome 表~~ | **不新建** | 决策/结果 = writeAuditEvent 写 order_logs/milestone_logs(payload 已 jsonb,decision_id 串链)。R1-D 已建成这套证据层。 |

**净新增:2 张表 + daily_tasks 加 5 列 + 1 个 task_type 值。零新任务/验收/决策/结果体系。**

## E. Text-first 实现范围(第一纵切)

**做**:文字输入框(CEO Today 内)→ 抽取 scene → 确认卡 → daily_tasks 委托行 → 员工提交 →
利润核对(读现有 order_financials/报价)→ verified/rework → CEO Today 结果区 → 全链反查。
单任务(欧璐报价)先跑通,采购/财务/reminder 多任务并发**这条通了再加回**。

**不做(本纵切)**:语音、邮件入 capture、企微、多任务扇出、依赖 DAG。

## F. Voice Second-step 设计(缓做,不阻塞)

正式链路(非 Web Speech):`录音 → 原始音频落 order-docs 桶(executive_captures.raw_audio_path)
→ 后端转写(可切模型)→ transcript 落库 → 复用 S2 抽取`。
理由(CEO):原音可追溯、转写可重试、可切模型、留 speaker/language/timestamp。
Web Speech API 仅作 optional live transcript 预览,**不作正式底座**。capture 表的 source_type/
raw_audio_path/transcript 三列已为此预留 —— text-first 阶段留空即可,加语音时不改表结构。

## G. 第一纵切验收标准(Gregory 缩版)

> "让欧璐准备 Gregory 当前项目的新报价,明天下午前完成,利润低于 15% 不要进入可发送状态。"

- [ ] Gregory 识别为 person 并关联到客户/项目("当前项目")
- [ ] "当前项目"关联正确
- [ ] 建立欧璐任务(assigned_to=欧璐 真实 user)
- [ ] deadline = 明天 18:00 正确落 due_at
- [ ] "利润<15%" 进入 acceptance_criteria
- [ ] CEO 一次确认(不逐字段点)
- [ ] 欧璐真实收到通知/任务
- [ ] 欧璐提交报价 → delegation_status=submitted(不是直接 done)
- [ ] 系统读取/计算利润率
- [ ] <15% → verifying→rework(打回);≥15% → verified
- [ ] CEO Today 显示结果
- [ ] 从结果可反查到 CEO 原始那句话(capture_item_id→capture_id→raw_text)
- [ ] 全程 Agent 不自主写终态(rework/verified 由规则+人工;"进入可发送"人工)

## 已知需扩(should,非本纵切阻塞)
- 升级链 `escalation-chain`/reminders 目前只扫 `milestones.due_at` —— 委托任务逾期升级需让它
  也扫 `daily_tasks` 的 ceo_delegation 行(加一个数据源,不改升级逻辑)。本纵切先做到 rework/verified,
  逾期升级在多任务阶段接。
