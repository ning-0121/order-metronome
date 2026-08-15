# ADR-006 — 数据访问分层与直连棘轮

**Status**: Accepted (2026-08-15) · 闸口:`npm run lint:data-access`(已入 `npm run check`)

## Context
全站有 **2324 处裸 `.from('table')`,散落在 288 个文件、897 个「文件·表」组合**里 —— action、组件、service、agent 谁都能直接摸表。
这不是风格问题,是**已经反复出过事的结构性根因**:

- **真相分叉**:同一张表的读写口径在多处各写一遍 → 订单头↔明细数量对不上([[quantity-semantics-invariant]])、分析件数口径分叉少算 21 张单。
- **RLS 静默失败**:裸 `.update()` 被滤成 0 行时 PostgREST **不报 error** → 只能靠 `lib/db/safe-mutation` 回读兜住(ADR 级闸 `lint:writes`)。
- **绕过统一入口**:37 处用 session 客户端直插 `notifications` 被 RLS 静默拒收;`order_logs` 放货审计 0 条。两次都是"能直接摸表"才发生的。
- **列漂移无人知**:`milestone_logs.payload` 从未落生产,13 类动作日志全空 —— 没有收口层,就没有一个地方能发现"这张表的写入形状变了"。

已有的 `lint:notif` / `lint:writes` / `lint:audit` 是**逐表打补丁**:每炸一次,加一张表的闸。
本 ADR 把它升级成**分层规则**:不再问"这张表能不能直连",而是问"**这一层该不该碰表**"。

## Decision

### 1. 允许直连表的层(白名单,只此一份)
| 层 | 路径 | 职责 |
|---|---|---|
| repository | `lib/repositories/` | 数据访问层本体 —— 收口某对象的读写 |
| adapter | `lib/adapters/` | 外部系统适配(目前为空,预留) |
| migration | `supabase/migrations/` · `scripts/` | 迁移 / 回填 / 一次性运维 |
| infra(明确白名单) | `lib/db/` · `lib/supabase/` · `lib/audit/write-audit-event.ts` · `lib/utils/notifications.ts` | 客户端工厂、安全写、审计/通知统一入口 |

**其余一律是业务层**(`app/**`、`components/**`、`lib/services/`、`lib/domain/`、`lib/agent/` …):不许直接摸表,去 `lib/repositories/` 建/用 repo。

### 2. 棘轮制:只出不进
- **存量直连 = 允许存在**,进 `scripts/data-access-baseline.json`(键=`文件 表`,值=次数),逐步清零;
- **新增直连 = lint fail**(同一「文件·表」计数超过基线即报);
- 键**不含行号** → 编辑漂移免疫,重构挪代码不会误报;
- 清了债记得 `--update-baseline` 收紧棘轮。

### 3. 基线只许缩不许涨
`--update-baseline` 若会让总数上涨,**直接拒绝写入**,必须显式 `--allow-growth`。
理由:基线是用来清零的,不是用来给新债背书的 —— 堵死"lint 红了就重刷基线"这条路。
要加 infra 白名单请改 `ALLOWED_LAYERS` 并在 PR 里写理由,不许偷偷刷基线。

## Consequences
- ✅ 债**封顶**:2324 处是天花板,不会再涨。
- ✅ 新功能被迫走 repository → 收口自然长出来,不需要一次性大重构。
- ✅ 逐表补丁(`lint:notif`/`lint:writes`/`lint:audit`)从此是**兜底**,不是唯一防线。
- ⚠️ 存量清零是长期工作(897 个「文件·表」),按域推进:动到哪个域,顺手把那个域的表收进 repo。
- ⚠️ 白名单里 `lib/adapters/` 目前为空 —— 建了外部系统适配层再往里放,别把 `lib/integration/` 顺手洗白(它读的是**我们自己的表**,那是债,不是适配)。
