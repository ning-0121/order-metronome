# QIMO Executive OS V1 — CEO Delegation Loop · 规划(2026-08-09)

> 只规划,不全量编码。目标:证明「CEO 按自己的方式工作,系统在身后把交代接住并执行」。
> 闭环:语音/文字 → AI 理解 → CEO 确认卡 → 分发 → 员工执行 → AI 核对 → 异常升级 → CEO 结果。

---

## 1. Current Reuse Audit(5 纵切并行只读盘点结论)

**一句话**:监控/汇总侧已成熟可大量复用,**委托闭环的"动作侧"是系统性空白**;缺口高度收敛。

| 纵切 | 可 as-is/minor 复用 | 硬缺(must) |
|---|---|---|
| S1 Capture | 邮件摄入(mail_inbox+email-scan)、文件直传(uploadPoForParse 绕 4.5MB)、Vision 多模态解析(po-extract)、文字入口(agent-chat) | **语音转写(全库 0)**、**跨渠道 CEO capture 表** |
| S2 Understand | generateObject 网关+宽容校验、不确定性约定(confidence_score/uncertain_fields)、草案→编辑→冻结(po_parse_drafts)、确认卡范式(agent_actions+AgentSuggestionCard) | **多实体抽取 schema**、**CEO 确认草案实体**、**实体消歧** |
| S3 Delegation | daily_tasks+upsertTask、"一判定扇出 N 任务"(order-decision)、按角色派发(notifyUsersByRole)、依赖 DAG(gates.ts) | **deadline 列**、**委托任务类型**、**验收标准字段** |
| S4 Verify | 逾期分级升级链(escalation-chain L1→L2→L3=CEO)、QC 返工闭环、多方确认状态机、督办总览 | **"已提交待验证"中间态**、**AI-as-verifier**、**委托任务载体表** |
| S5 CEO Today | 需决策聚合(pending-approvals 7 源)、风险面板(computeOrderStatus+RuntimeRiskCard)、客户事项物化、驾驶舱员工报告区 | **语音命令入口**、**CEO 确认卡**、**委托单据(你委托的 真相源)** |

**关键洞察**:五个纵切的 must 缺口其实是**同一组东西** —— ①一张 CEO capture 表 ②一张 CEO 委托任务表(带 deadline/验收/提交-验证状态机)③两个 AI scene(抽取 + 核对)④语音入口。R1 建成的基座(safeMutation/writeAuditEvent/insertNotifications/generateObject/escalation-chain/确认卡范式)**全部可直接承接**,不重造。

---

## 2. V1 Data Gap(逐纵切数据缺口)

- **S1**:无"CEO 原始输入"落点。mail_inbox 是邮件专用+客户导向,不能塞。→ 新表 `exec_captures`。
- **S2**:抽取结果无处放(document_extractions 是文档专用)。→ 新表 `exec_intents`(草案:多实体+多待办+confidence+确认态)。实体消歧复用 customers/factories/profiles 现有模糊匹配。
- **S3**:daily_tasks 缺 `due_at`(只有 task_date=生成日)、缺委托类型、缺验收标准、缺批次分组。委托是**跨日持久对象**,而 daily_tasks 是每日重建语义 → 不复用 daily_tasks,新表 `exec_delegations`。
- **S4**:milestone 四态无"已提交待验证";委托任务需独立状态机 → 落在 `exec_delegations.status`。AI 核对结论 → 落 `exec_verifications`。
- **S5**:六分类的"你委托的/AI已处理"真相源缺 → 由 exec_delegations + writeAuditEvent(actor=agent)供给;其余四类复用现成聚合。

---

## 3. V1 ERD Delta(最小新增集 —— 4 张表)

```
exec_captures        CEO 原始输入(每条一行)
  id, actor_user_id(=CEO), channel(voice|text|mail|wecom|file),
  raw_text, transcript, media_path(order-docs 桶复用), source_ref,
  status(captured|parsed|confirmed|discarded), created_at
        │ 1
        ▼ N
exec_intents         AI 抽取的结构化草案(一次 capture 可多 intent)
  id, capture_id→exec_captures, intent_type(fact|commitment|decision|task|risk|reminder|rule),
  payload(jsonb: 实体/日期/数量/tentative 等), confidence numeric(3,2),
  uncertain_fields text[], linked_customer_id, linked_person, linked_order_id,
  confirmed bool, created_at            -- 30秒确认卡读它
        │ 1(task 类 intent 确认后)
        ▼ N
exec_delegations     CEO 委托任务(一等对象,跨日持久)
  id, capture_id, batch_id(同次确认的一批共享), title, description,
  owner_user_id, owner_role, due_at, acceptance_criteria,
  depends_on uuid[](任务间依赖), risk_level,
  status(delegated|in_progress|submitted|verifying|verified|rework|overdue|escalated|done|cancelled),
  submitted_at, submitted_note, created_by(=CEO), created_at
        │ 1
        ▼ N
exec_verifications   AI/人工对提交的核对结论
  id, delegation_id→exec_delegations, verifier_type(ai|human),
  verdict(pass|fail|need_info), reason, evidence_ref,
  escalated_to, created_at
```

**复用现表(不新建)**:order-docs 桶(文件本体)、profiles(owner/实体)、customers/factories(实体消歧)、
milestone_logs/order_logs(经 writeAuditEvent 留痕,decision_id=capture_id 串反查链)、notifications(派发/升级/结果)。

**全部走 R1 基座**:写 exec_* 一律 safeMutation/safeCriticalMutation;审计 writeAuditEvent(actor 含 on_behalf_of);
派发/升级 insertNotifications+notifyUsersByRole;RLS:exec_captures/intents 仅 CEO+admin,exec_delegations owner+CEO+admin 可见。

---

## 4. State Machines(三台状态机)

**A. Capture**:`captured → parsed(AI 抽取完)→ confirmed(CEO 点确认)→ [扇出 delegations] / discarded`

**B. Delegation(核心 —— 提交≠完成)**:
```
delegated → in_progress → submitted → verifying → ┬ verified → done
                            ↑                      ├ rework → in_progress(打回,记次数)
                            │                      └ need_info → in_progress
   任何非终态 + 过 due_at → overdue → (逾期升级)→ escalated(→主管→CEO)
```
- **submitted ≠ done** 是 S4 的核心:员工点"提交"进 `submitted`,**必须过 verifying** 才到 verified。
- 状态转移全走 safeCriticalMutation(断言+回读),通知垫底;escalated 复用 escalation-chain。

**C. Verification**:`verifying → {pass→verified | fail→rework | need_info→回填}`;verifier=ai 时产出建议,
**终态化仍需人工确认或规则**(Agent 不自主写终态,守 RESTRICT)。

---

## 5. CEO UX Flow(三入口 × 三密度,默认 30 秒)

**三入口**(其余 ERP 退后台):
- **Voice**:随时说 → 转写 → 确认卡。核心动线,球场/机场/车上一句话。
- **Today**:六分类(需你决策 / 有风险 / 你委托的 / 已完成验证 / AI已处理 / 会议准备)。
- **People/Company**:随时调某人/客户/项目上下文。

**三密度**(默认先给 30 秒):
| | 30 秒 | 3 分钟 | 15 分钟 |
|---|---|---|---|
| 确认卡 | 一句话摘要+确认/改 | 展开每个任务 owner/deadline | 编辑实体、加验收 |
| Today | 六分类计数+红点 | 每类 top3 | 逐项详情+反查链 |

**确认卡范式**复用 AgentSuggestionCard(严重度色阶+二次确认+撤销),数据源换 exec_intents。

---

## 6. S1–S5 Implementation Plan(分纵切,标复用/新建)

| 纵切 | 新建(最小) | 复用 | 顺序 |
|---|---|---|---|
| S1 | exec_captures 表 + 文字/文件入口接线 + **语音转写**(浏览器 Web Speech API 先行,零后端) | uploadPoForParse、mail_inbox、agent-chat | 1 |
| S2 | exec_intents 表 + 多实体抽取 scene(generateObject+新 SchemaValidator)+ 实体消歧 | generateObject 网关、confidence 约定、po-parser draft 生命周期 | 2 |
| S3 | exec_delegations 表 + 确认→扇出多任务(safeCriticalMutation) | order-decision 扇出、notifyUsersByRole、gates 依赖 | 3 |
| S4 | exec_verifications 表 + 提交/验证状态机 + AI 核对 scene | escalation-chain、QC 返工范式、多方确认 | 4 |
| S5 | CEO Today 六分类页(委托区新建,其余聚合复用) | pending-approvals、风险面板、customer-matters | 5 |

**第一纵切验收用例(必须真实跑通)** —— Gregory 场景:
> "Gregory 说下个月可能来中国。让欧璐准备当前项目新报价,采购明天下午前把成本核好,财务评估 ROG60/ROG90 资金占用。周二提醒我确认付款条件。利润低于 15% 不要发客户。"

必须产出:原始输入落 exec_captures → 识别 Gregory(person,tentative"可能来"**不写成已确认**)→ 关联客户 →
抽出 3 任务(欧璐报价 / 采购成本 明天下午前 / 财务 ROG 评估)+ 1 CEO reminder(周二)+ 1 rule(利润<15% 不发客户,RESTRICT:对外发送人工)→
一张确认卡一次确认 → 扇出 3 条 exec_delegations 派发 → 员工提交 → AI 核对 → 异常升级 → CEO 结果回执 → 全链 decision_id 反查。

---

## 安全边界(继承 R1-F,贯穿全 V1)
- Agent 只能:分析 / 草稿 / 建议 / 内部任务 / 提醒 / 查询。**不自主**改价/发货/财务/对外发送。
- exec_delegations 里涉 RESTRICT 的 intent(如"利润<15%不发客户")→ 只生成**人工待办**,系统不自动执行对外动作。
- **V1 授予任何 Agent 自主写前置**:先把 agent-execute 的 direct mutation 迁入 Business Command(R1-F G 节)。
- 所有 exec_* 写入走 safeMutation/writeAuditEvent —— 委托系统本身也遵守"系统不撒谎"。
