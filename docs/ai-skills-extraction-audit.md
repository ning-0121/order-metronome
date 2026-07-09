# AI Skills 抽离审计 — Extraction Audit

> 目的：判断 Order Metronome 现有 AI Skills 中，哪些可以抽成独立、与公司无关的 `trade-agent-skills` 库。
> 性质：**纯审计 + 设计**。本文不改任何代码、不移动任何 skill 文件、不创建任何仓库。
> 关联文档：[product-boundary.md](./product-boundary.md) · [shared-core-registry.md](./shared-core-registry.md) · [shared-release-process.md](./shared-release-process.md)
>
> 审计基线：`lib/agent/skills/`（7 个 skill + `runner.ts` + `types.ts`）及 `lib/agent/garmentDefectDetect.ts` 等。
> 审计日期：2026-06-09。

---

## 1. 总结论

### 1.1 三档分类

| 档位 | Skill | 标签 |
|------|-------|------|
| 🟢 **可抽**（Phase 1） | `types.ts` 契约、`garmentDefectDetect`、`deliveryFeasibility`、`missingInfo` 引擎 | `[SHARED]` / `[ABSTRACTED]` |
| 🟡 **暂不抽**（Phase 2+） | `riskAssessment`、`customerEmailInsights`、`todayActions`、`runner` harness、`professionalKnowledge` / `industryKnowledge` | `[ABSTRACTED]`（待沉淀） |
| 🔴 **永不抽** | `quoteReview` | `[INTERNAL]`（定价 IP） |

### 1.2 关键发现

- **没有客户名硬编码**：在 `lib/agent/skills/` 目录下 grep `绮陌 / qimo / EHL / POPFIT / Cotton Candy / 傲狐 / 年年旺` —— **0 命中**。
  因此 product-boundary.md 把 AI Skills 一刀切为 `[INTERNAL]` 是**过粗**的：真正的耦合不在"客户数据"，而在下面三处。
- **真正的耦合点**：
  1. **不纯**：每个 skill 的 `run(input, context)` 直接用 `context.supabase` 查表 —— 取数与逻辑糊在一起。
  2. **领域知识混杂**：`professionalKnowledge.ts` 是「通用骨架 + Qimo 专属行（`tags: ['qimo']`、标题 `[待用户补充] 绮陌…`）」混在同一文件。
  3. **定价 IP**：`quoteReview` 含成本/利润/报价比对逻辑，属 product-boundary 明示的核心机密。

### 1.3 为什么不能直接搬代码

| 障碍 | 说明 | 解法 |
|------|------|------|
| **副作用糊在逻辑里** | `run()` 内既查 DB（`context.supabase.from(...)`）又算分。直接搬会把 `supabase` 依赖一起带走，包就不通用了。 | 做 **Gather → Compute → Apply** 三段切分：取数留 OM，纯计算进包，落库/展示留 OM。 |
| **隐式时钟/环境** | 逻辑里出现 `Date.now()` / `process.env`，导致输出不可复现、不可测。 | `compute()` 内禁用，时钟/配置由入参注入。 |
| **LLM 客户端硬依赖** | 多个 skill `import { callClaudeJSON } from '@/lib/agent/anthropicClient'`。 | 抽象成 `LlmPort` 接口注入，包不绑具体 SDK。 |
| **知识库混了 Qimo 行** | `professionalKnowledge` 通用条目与 `qimo` 专属条目同文件。 | 拆「通用默认」（进包）vs「Qimo override」（留内部）。 |
| **harness 绑 infra 表** | `runner` 直接写 `ai_skill_runs` / `ai_skill_circuit_state`。 | 缓存/熔断/审计改成端口（`CachePort`/`CircuitPort`/`AuditPort`）注入。 |

---

## 2. 全 skill 审计表

| Skill 文件 | 调用 AI | 依赖表 | Qimo-specific 逻辑 | 能否改纯输入/输出 | 抽离判定 |
|---|---|---|---|---|---|
| **garmentDefectDetect.ts** (166) | ✅ Vision | **无** | 无（15 年品控通用 prompt） | ✅ **已是纯函数**：图片→报告，仅依赖 LLM | 🟢 `[SHARED]` 立即可抽 |
| **deliveryFeasibility.ts** (209) | ❌ | orders, milestones | 无（交期可行性=通用外贸逻辑） | ✅ 易：历史周期 + 工厂负荷做成 snapshot 入参 | 🟢 `[SHARED]`（改造小） |
| **missingInfo.ts** (450) | ❌ 纯规则 | orders, milestones, order_attachments | 规则表引用 18 关卡 key / file_type（行业标准，非客户专属） | ✅ 引擎纯，规则表外置为 config | 🟡 `[ABSTRACTED]`（引擎抽、规则做默认 + override） |
| **todayActions.ts** (169) | ❌ 纯聚合 | milestones, delay_requests, notifications | 耦合 OM 任务/通知模型 | ⚠️ 中：需把"逾期/到期"算法与通知模型解耦 | 🟡 `[ABSTRACTED]`（算法可抽，数据模型留 OM） |
| **riskAssessment.ts** (1323) | ✅ 规则 80% + AI 解释 | orders, milestones, customer_memory, factories, order_attachments, order_confirmations, order_financials | 加权评分本身通用；但耦合 7 张表 + 知识库 + 里程碑 key | ✅ 可，但工作量大：7 张表 → 单个 snapshot | 🟡 `[ABSTRACTED]`（评分核心抽，取数留 OM）**不进 Phase 1** |
| **customerEmailInsights.ts** (221) | ✅ | mail_inbox, orders | prompt 通用；数据源绑 Qimo 邮件集成 | ⚠️ 中：邮件 snapshot 入参，集成留 OM | 🟡 `[ABSTRACTED]`（后期） |
| **quoteReview.ts** (472) | ✅ | orders, order_attachments, order_cost_baseline | **成本/利润/定价逻辑 = 核心 IP** | 技术上可，**业务上不应** | 🔴 `[INTERNAL]` 永不抽 |
| **runner.ts** (287) | — | ai_skill_runs, ai_skill_circuit_state | 无（熔断/缓存/shadow/审计=通用 harness） | 需把 DB 访问换成注入端口 | 🟡 harness 抽成 SDK 核心（Phase 2） |
| **types.ts** (122) | — | 无 | 无 | 已是干净契约 | 🟢 第一个搬（契约层） |

> 补充：`garmentDefectDetect` 未实现 `SkillModule` 接口、也不在 runner 注册表里，是被 `app/actions/defect-detect.ts` 直接调用的独立函数 —— 这正是它"最干净"的原因。

---

## 3. 三层架构

抽离后系统分三层，依赖方向单向向下（上层依赖下层，下层永不知道上层）：

```
┌─────────────────────────────────────────────────────────────┐
│  C. Qimo-specific Overrides（留在 Order Metronome / 内部）      │
│     - professionalKnowledge 里的 qimo 行、客户专属规则           │
│     - 定价/成本策略（quoteReview）                              │
│     - 邮件/财务系统集成                                          │
│     依赖 ↓ B、A                                                 │
├─────────────────────────────────────────────────────────────┤
│  B. Order Metronome Adapter / Gatherer（留在 OM，不进包）       │
│     - gatherers/  : 查 orders/milestones/... → 纯 JSON Snapshot │
│     - ports/      : supabase-llm / supabase-cache / -circuit   │
│     - register.ts : 把纯 skill + adapter 接起来喂给现有 UI       │
│     依赖 ↓ A                                                    │
├─────────────────────────────────────────────────────────────┤
│  A. trade-agent-skills 纯 skill 库（独立 repo，零 DB / 零 SDK）  │
│     - contracts/ : SkillResult / PureSkillInput / LlmPort      │
│     - skills/    : compute(snapshot, {llm}) → SkillResult      │
│     - config/    : 通用默认规则 / 通用知识                       │
│     - harness/   : 通用 run-skill（端口注入版，Phase 2）         │
│     不认识 supabase、不认识 Anthropic SDK、不认识 Qimo            │
└─────────────────────────────────────────────────────────────┘
```

**职责切分（Gather → Compute → Apply）**：

| 阶段 | 在哪层 | 做什么 |
|------|--------|--------|
| Gather | B（OM adapter） | 用 `supabase` 查表，组装成纯 JSON `Snapshot` |
| Compute | A（纯包） | `compute(snapshot, {llm})` 纯计算，返回 `SkillResult` |
| Apply | B（OM adapter） | 把 `SkillResult` 落库（`ai_skill_runs`）/ 渲染到 UI |

---

## 4. SkillResult 标准格式

**输出契约沿用当前 `lib/agent/skills/types.ts` 的 `SkillResult`（不变）**，仅在其基础上补充"纯化"所需的三个类型，并加一条铁律。

```ts
// ── 输出：沿用现有 SkillResult（保持不变）──────────────────────
interface SkillResult {
  severity: 'high' | 'medium' | 'low';
  score?: number;            // 0-100
  summary: string;
  findings: SkillFinding[];
  suggestions: SkillSuggestion[];
  confidence: number;        // 0-100
  source: 'rules' | 'rules+ai' | 'cached' | 'manual';
  meta?: Record<string, any>;
}
// SkillFinding / SkillSuggestion 同 types.ts，不变。

// ── 新增 1：纯输入（完全物化的数据快照，不含 orderId-去查表）──────
interface PureSkillInput<TSnapshot> {
  snapshot: TSnapshot;       // 由 OM 侧 gatherer 查表后喂入的纯 JSON
  now: string;               // 注入时钟（ISO 字符串），便于测试，禁止内部取系统时间
}

// ── 新增 2：LLM 端口（包不绑 anthropicClient）─────────────────
interface LlmPort {
  json<T>(req: {
    system: string;
    messages: any[];
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<T | null>;
}

// ── 新增 3：纯 skill 接口 ───────────────────────────────────
interface PureSkill<TSnapshot> {
  name: string;
  displayName: string;
  compute(
    input: PureSkillInput<TSnapshot>,
    deps: { llm?: LlmPort },     // 无 AI 的 skill 不传 llm
  ): Promise<SkillResult>;
}
```

### 铁律（CI 应静态检查）

> **`compute()` 函数体内禁止出现：`supabase`、`fetch`、`Date.now()`、`new Date()`（无参）、`process.env`。**

取数、网络、时钟、环境配置一律由 OM 侧 adapter 提供（通过 `snapshot` / `now` / `deps`）。
违反 = 包失去通用性，等于没抽。

---

## 5. 新仓库结构 `trade-agent-skills`

> 独立 repo，`package.json` name: `trade-agent-skills`，**零运行时依赖**（LLM/DB 全靠注入）。
> 按 [product-boundary.md 双版本规则] **不从生产 main fork**，从稳定 tag clone。

```
trade-agent-skills/
├── package.json
├── README.md
├── src/
│   ├── contracts/                  # 契约层（最先搬，对应 types.ts）
│   │   ├── result.ts               # SkillResult / SkillFinding / SkillSuggestion
│   │   ├── input.ts                # PureSkillInput<T> + 各 skill 的 Snapshot 类型
│   │   ├── skill.ts                # PureSkill 接口
│   │   └── ports.ts                # LlmPort（+ 预留 ClockPort）
│   ├── skills/                     # 纯计算核心，一 skill 一目录
│   │   ├── garment-defect-detect/  # 🟢 纯 vision（图片入参，无 snapshot）
│   │   │   ├── index.ts
│   │   │   ├── prompt.ts           # 通用品控 prompt
│   │   │   └── index.test.ts
│   │   ├── delivery-feasibility/   # 🟢 纯评分
│   │   │   ├── index.ts
│   │   │   └── index.test.ts
│   │   └── missing-info/           # 🟡 引擎 + 默认规则
│   │       ├── engine.ts           # 通用引擎
│   │       ├── default-rules.ts    # 行业默认规则（OM 可 override）
│   │       └── engine.test.ts
│   ├── config/                     # 通用默认（[ABSTRACTED]，剔除 qimo 行）
│   │   └── knowledge/
│   └── harness/                    # Phase 2：通用 runner（端口注入版）
│       ├── run-skill.ts            # shadow / cache / circuit 逻辑
│       └── ports.ts                # CachePort / CircuitPort / AuditPort
└── test/

# OM 侧保留（不进包，仅示意，本文不创建）：
order-metronome/lib/agent/skills-adapter/
├── gatherers/                      # 查表 → Snapshot（orders/milestones/... 全在这）
├── ports/                          # supabase-llm.ts / supabase-cache.ts / supabase-circuit.ts
└── register.ts                     # 纯 skill + OM adapter 接线，喂给现有 UI
```

---

## 6. Phase 1 迁移计划

**目标**：抽出「契约 + 2 个纯 skill + 1 个规则引擎」，验证三段切分模式可行。

### 6.1 范围

**只包含：**
- `types.ts` 契约（→ `src/contracts/`）
- `garmentDefectDetect`（→ `src/skills/garment-defect-detect/`）
- `deliveryFeasibility`（→ `src/skills/delivery-feasibility/`）
- `missingInfo` engine（→ `src/skills/missing-info/`，规则做默认 + override）

**明确不包含（Phase 1 绝不动）：**
- `quoteReview`（定价 IP，永不抽）
- `riskAssessment`（7 表耦合，先沉淀 snapshot 契约）
- `customerEmailInsights`（绑邮件集成）
- `todayActions`（绑通知/任务模型）
- `runner` harness（Phase 2 改注入端口）
- `professionalKnowledge` / `industryKnowledge`（Phase 3 拆通用 / Qimo）

### 6.2 步骤

| 步 | 动作 | 产物 | 验收 |
|---|------|------|------|
| 1 | 在 OM 内**先做切分，不建仓库**：确认 `garmentDefectDetect` 纯逻辑与 `app/actions/defect-detect.ts` 的 IO 边界 | 边界清单 | defect 功能不变 |
| 2 | 冻结 `SkillResult`，新增 `PureSkillInput` / `LlmPort` / `PureSkill`（先放 OM 内 `lib/agent/skills/contracts/`） | 契约文件 | build + check |
| 3 | 给 `deliveryFeasibility` 写 gatherer（orders/milestones → snapshot），`run` 改 `compute(snapshot)` | 改造样板 | 输出逐字段与改造前一致 |
| 4 | `missingInfo` 同切：引擎纯化，规则表抽成 `default-rules.ts`（OM 可 override） | 规则引擎 | 缺失项结果不变 |
| 5 | **新建 `trade-agent-skills` 仓库**（独立 repo，不 fork 生产 main），搬 contracts + 3 个纯核心，发 `0.1.0` | 独立包 | 包内单测全绿、零 supabase 依赖 |
| 6 | OM 改 `import { ... } from 'trade-agent-skills'`，adapter 留本地；UI/runner 不动 | 接线 | 三个 skill 线上行为零变化 |
| 7 | 更新治理文档（见 §7） | 登记 | — |

### 6.3 Phase 1 完成标志

`trade-agent-skills` 里 3 个 skill **零 DB、零 Anthropic 直依赖、纯单测可跑**；OM 通过 adapter 注入，线上无回归。

---

## 7. 治理建议

| 文档 | 改动 |
|------|------|
| **product-boundary.md** | 「Internal Only」表里的 `AI Skill 后台 / lib/agent/skills/` 一行，从一刀切 `[INTERNAL]` 改成**逐 skill 分类**（指向本文）。Shared Core 表新增 `trade-agent-skills`（`[SHARED]`，规划中）。 |
| **shared-core-registry.md** | 新增条目 `trade-agent-skills`：标签 `[SHARED]` / `[ABSTRACTED]`，`release_status: planned`，`synced_to_commercial: ❌`。登记 Phase 1 范围、Gather→Compute→Apply 模式、`compute()` 铁律。 |
| **分类原则（写入登记表）** | AI Skill 不再整体归 `[INTERNAL]`，按：纯逻辑 → `[SHARED]`；通用骨架 + 可配置 → `[ABSTRACTED]`；定价/客户专属 → `[INTERNAL]`。 |

> 晋升路径：Phase 1 在 OM 内切分验证 → 建包 → `internal_validated` → audited → 进 commercial-sync-backlog → released。

---

*本文为审计与设计文档，不含任何代码改动。落地需按 Phase 1 计划逐步执行，每步 build + check，并遵守 CLAUDE.md 的 push 前规程。*
