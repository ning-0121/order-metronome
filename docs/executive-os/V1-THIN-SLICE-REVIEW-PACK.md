# V1 Thin Slice — 第一 commit 前评审材料(2026-08-09)

> CEO 拍板:3 独立表,`executive_delegations` = canonical source of truth,
> daily_tasks/notifications = derived projection。本包 8 项,评审通过即编码。**尚未建表。**

核实事实(实施依赖):欧璐 user_id=`4ceaceb2-873a-43f8-bd9a-09ce49df9c41`(merchandiser,真实);
**Gregory 不在 customers 库** → capture_item 必须能表达"人未入库"(tentative,不强绑 id);
`order_financials.margin_pct` 是现成利润字段 → 核对规则有真实落点。

---

## 1. 三张表精确 schema(migration 草案,待评审后落 supabase/migrations)

```sql
-- executive_captures:CEO 原始输入(raw,永不被 AI/确认覆盖)
create table public.executive_captures (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,                 -- CEO(=白名单 admin)
  source_type text not null default 'text'
    check (source_type in ('text','voice','mail','file')),
  raw_text text,                               -- text-first 主载体
  raw_audio_path text,                         -- Voice 第二步:order-docs 桶路径(V1 留空)
  transcript text,                             -- Voice 转写结果(V1 留空)
  content_hash text,                           -- sha256(raw_text) 幂等去重(误触重复提交)
  processing_status text not null default 'captured'
    check (processing_status in ('captured','parsing','parsed','confirmed','discarded')),
  metadata jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- executive_capture_items:AI 抽取草案(AI interpretation 层,与 raw、与 confirm 三层分离)
create table public.executive_capture_items (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.executive_captures(id) on delete cascade,
  item_type text not null
    check (item_type in ('fact','proposed_delegation','constraint','risk')),  -- V1 四类
  structured_payload jsonb not null,           -- {owner_hint,action,deadline,person,customer_hint,rule…}
  confidence numeric(3,2),
  source_start int, source_end int,            -- 原文片段定位(可空)
  confirmation_status text not null default 'pending'
    check (confirmation_status in ('pending','confirmed','edited','rejected')),
  confirmed_by uuid, confirmed_at timestamptz,
  spawned_delegation_id uuid,                  -- 确认后回填(→ executive_delegations)
  created_at timestamptz not null default now()
);

-- executive_delegations:CEO 委托 —— 唯一真相源(跨日/跨延期/跨返工)
create table public.executive_delegations (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid references public.executive_captures(id),
  capture_item_id uuid references public.executive_capture_items(id),  -- 反查链锚
  title text not null,
  instruction text not null,                   -- 给员工的原话/整理后指令
  why text,                                    -- 背景(Gregory 可能来中国 等)
  owner_user_id uuid not null,                 -- 欧璐
  reviewer_user_id uuid,                       -- 核对人(V1 规则核对可空)
  deadline timestamptz,
  priority int not null default 3 check (priority in (1,2,3)),
  acceptance_criteria text,                    -- "利润率 ≥15%"
  constraints jsonb,                           -- [{type:'min_margin',value:15,restrict:'send'}]
  delegation_status text not null default 'confirmed'
    check (delegation_status in
      ('confirmed','assigned','accepted','in_progress','submitted','verifying',
       'verified','blocked','overdue','rework','cancelled','needs_ceo')),
  submitted_at timestamptz,
  submission_summary text,
  submission_artifact_refs jsonb,              -- 附件/报价引用
  verification_status text check (verification_status in ('pending','pass','fail','need_info')),
  verification_result jsonb,                   -- {margin_pct:14.2,threshold:15}
  verification_reason text,
  verified_by uuid, verified_at timestamptz,
  created_by uuid not null,                    -- CEO
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## 2. Indexes / FK / RLS

```sql
-- indexes
create index idx_exec_captures_actor on public.executive_captures(actor_user_id, captured_at desc);
create index idx_exec_captures_hash on public.executive_captures(content_hash);
create index idx_exec_items_capture on public.executive_capture_items(capture_id);
create index idx_exec_deleg_owner on public.executive_delegations(owner_user_id, delegation_status);
create index idx_exec_deleg_status_due on public.executive_delegations(delegation_status, deadline);
create index idx_exec_deleg_capture on public.executive_delegations(capture_id);

-- FK:已在表内声明(capture_item→capture cascade;delegation→capture/item 保留)

-- RLS:写一律 service-role(经 Business Command);读按角色
alter table public.executive_captures enable row level security;
alter table public.executive_capture_items enable row level security;
alter table public.executive_delegations enable row level security;

-- captures/items:仅 CEO 本人 + admin 可读(CEO 私密输入)
create policy exec_cap_sel on public.executive_captures for select
  using (actor_user_id = auth.uid()
     or exists (select 1 from public.profiles p where p.user_id=auth.uid()
                and (p.role='admin' or 'admin'=any(p.roles))));
create policy exec_item_sel on public.executive_capture_items for select
  using (exists (select 1 from public.executive_captures c where c.id=capture_id
                 and (c.actor_user_id=auth.uid()
                   or exists (select 1 from public.profiles p where p.user_id=auth.uid()
                              and (p.role='admin' or 'admin'=any(p.roles))))));
-- delegations:owner / reviewer / 创建者(CEO)/ admin 可读(员工要看到派给自己的)
create policy exec_deleg_sel on public.executive_delegations for select
  using (owner_user_id = auth.uid() or reviewer_user_id = auth.uid() or created_by = auth.uid()
     or exists (select 1 from public.profiles p where p.user_id=auth.uid()
                and (p.role='admin' or 'admin'=any(p.roles))));
-- 无 INSERT/UPDATE 策略 → 只有 service-role(Business Command)可写,守 R1 边界
```

## 3. Gregory Sequence(thin slice)

```
CEO(text) ─"让欧璐把Gregory当前项目新报价明天下午前做好,利润低于15%不要发"
  │
  ▼ captureCeoInput(text)          [Business Command, svc]
  executive_captures ← {raw_text, content_hash, status=captured}
  │
  ▼ parseCapture(captureId)        [generateObject, scene=exec.delegation.extract]
  executive_capture_items ←
    · proposed_delegation {owner_hint:'欧璐', action:'Gregory当前项目新报价',
                           deadline:'明天18:00', person:'Gregory'(未入库,tentative)}
    · constraint {type:'min_margin', value:15, restrict:'send'}
  status=parsed
  │
  ▼ CEO Today 弹 Confirmation Card(读 items,30 秒版)
  │  [确认并分配] / [修改] / [只记录]
  ▼ confirmDelegation(captureId, edits)   [safeCriticalMutation, svc, A2 audit]
  executive_delegations ← {owner=欧璐, deadline, acceptance_criteria='利润≥15%',
                           constraints, delegation_status=assigned, capture_item_id}
  item.spawned_delegation_id 回填;capture.status=confirmed
  writeAuditEvent(A2, decision_id=captureId, actor=CEO)
  → 投影:insertNotifications(欧璐) + daily_tasks 投影行(projection,非真相)
  │
  ▼ 欧璐 Today 看到(delegation 投影)→ 做报价 → submitDelegation(id, {margin_pct, summary})
  executive_delegations.delegation_status=submitted, verification_status=pending
  │
  ▼ verifyDelegation(id)           [规则核对]
  margin_pct >= 15 → verified   (verification_status=pass)
  margin_pct <  15 → rework      (fail + reason + 通知欧璐;不得进入 send-ready)
  │
  ▼ CEO Today「你委托的 / 已完成验证」显示;点入反查 capture_item→capture→raw_text
```

## 4. 页面最小改动范围

| 页面 | 改动 | 类型 |
|---|---|---|
| `app/ceo/page.tsx` | 加"交代一件事"文字输入框 + 确认卡挂载 + "你委托的/已完成验证"两区读 executive_delegations | 改 |
| 新 `components/exec/DelegationConfirmCard.tsx` | 确认卡(复用 AgentSuggestionCard 视觉) | 新 |
| 新 `components/exec/DelegationInbox.tsx` | 员工 Today 看派给自己的委托 + 提交按钮 | 新 |
| `app/my-today/page.tsx` | 挂 DelegationInbox(员工侧投影入口) | 改 |

**不动**:其余 ERP/生产/财务页。

## 5. API / Server Action 清单(全部 Business Command,svc + safeMutation + audit)

| action | 文件 | 作用 |
|---|---|---|
| `captureCeoInput(text)` | 新 `app/actions/exec-capture.ts` | 落 executive_captures(content_hash 去重) |
| `parseCapture(captureId)` | 同上 | 调 AI scene → 落 capture_items |
| `confirmDelegation(captureId, edits)` | 新 `app/actions/exec-delegation.ts` | 确认→建 delegation(safeCriticalMutation)+投影+通知+A2 审计 |
| `submitDelegation(id, payload)` | 同上 | 员工提交 → submitted(owner 鉴权) |
| `verifyDelegation(id)` | 同上 | 规则核对 → verified/rework |
| `getMyDelegations()` / `getCeoDelegations()` | 同上 | 读投影(RLS 兜底) |

## 6. AI Scene Schema(exec.delegation.extract)

复用 `qimoAI.generateObject`(scene='exec.delegation.extract', capability='structured-extraction',
riskLevel='high'),新 SchemaValidator(宽容:抓到多少填多少,不确定进 confidence/notes):

```ts
{ items: Array<{
    item_type: 'fact'|'proposed_delegation'|'constraint'|'risk',
    owner_hint?: string,          // "欧璐" —— 后端再消歧到 user_id
    action?: string,
    deadline_text?: string,       // "明天下午" —— 后端解析成 timestamptz
    person?: string,              // "Gregory"(可未入库)
    customer_hint?: string,
    tentative?: boolean,          // "可能来中国" → true,不写成已确认
    constraint_type?: string, constraint_value?: number, restrict?: string,
    confidence: number,
  }> }
```
system prompt 铁律:**区分事实 vs 可能**(tentative)、**不臆造未说的字段**、**owner 只填原话提到的名字**。

## 7. Failure Cases(必须不 silent success)

| 场景 | 处置 |
|---|---|
| AI 抽取返回空/超时 | capture.status=parsed 但 0 items → 确认卡显示"没抽到可执行事项,可手动补",不静默 |
| owner_hint 消歧不到人(如打错名) | delegation 不建;确认卡标红"欧璐 未匹配到员工",CEO 手选 |
| Gregory 未入库 | 允许:person 存自由文本 + tentative,不阻断;不伪造 customer_id |
| deadline 解析失败 | deadline 留空 + 确认卡要求 CEO 补;不猜 |
| confirmDelegation 写库 0 行/失败 | safeCriticalMutation 返回 zero_rows/db_error → 报错、不通知员工、capture 不标 confirmed(A2:审计失败→completed_unverified) |
| submitDelegation 非 owner 调用 | forbidden |
| 利润字段缺失 | verification_status=need_info(不判 pass 也不判 fail),要员工补 margin |
| 重复提交同一句话 | content_hash 命中 → 复用已有 capture,不重复建 |

## 8. Migration Rollback Plan

- 迁移纯新增(3 表 + index + policy),**零改现有表** → 回滚 = `drop table executive_delegations,
  executive_capture_items, executive_captures cascade;`(无数据依赖,安全)
- daily_tasks/notifications 只读投影,回滚删表不影响它们(投影行可留可清,不是真相)
- 代码回滚:revert 相关 commit;CEO 页新增区块 feature-flag 包裹(`EXEC_OS_V1` env),
  off 时完全不渲染,坏了立即关闭不影响存量

---

## 守住的边界(全程)
- executive_delegations = 真相源;daily_tasks/notifications = 投影,**禁止反向**(daily_tasks.done ≠ 委托完成)
- 写 exec_* 一律 service-role Business Command + safeMutation + writeAuditEvent
- Agent 不自主写终态:verified/rework 由规则+人工;"进入可发送状态"是人工动作(RESTRICT)
- 不预建:多轮 verification 历史表 / decision 表 / outcome 表 / 通用工作流引擎
