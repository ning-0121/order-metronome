# Commercial Sync Backlog — 待同步 PR 队列

> 这份文件登记**所有等待从 main 同步到 commercial-product 的 `[SHARED]` 模块**。
> 完成后的 PR 应从 backlog 移到「已完成」表，不删除条目（保留历史）。
>
> 治理规则：详见 [shared-release-process.md](./shared-release-process.md)。
> 模块清单：详见 [shared-core-registry.md](./shared-core-registry.md)。

---

## 状态字段

| 字段 | 取值 |
|------|------|
| `状态` | `pending` / `audited` / `sync-branch-ready` / `merged` / `verified` |
| `优先级` | `P0`（生产 bug，演示前必修）/ `P1`（共享逻辑）/ `P2`（知识层）/ `P3`（注释）|

---

## Pending 队列

### PR-1 ｜ P0 修复 + 文档基线对齐

**目标**：消除 commercial-product 上的演示 blocker；文档治理体系对齐。

| 字段 | 值 |
|------|---|
| 状态 | `pending` |
| 优先级 | **P0** |
| 风险 | 极低 |
| 含 Qimo-specific 数据 | ❌ |

**含 5 个文件**：

| 文件 | 类型 |
|------|------|
| `app/actions/export-production-sheet.ts` | bug fix — `orders.status` → `lifecycle_status` |
| `app/actions/users.ts` | bug fix — 同上 |
| `docs/shared-core-registry.md` | 文档同步 |
| `docs/product-boundary.md` | 文档同步（用 main 版覆盖 commercial 旧版）|
| `docs/execution-engine.md` | 文档同步（含 Progressive Validation 章节）|
| `docs/shared-release-process.md` | 文档新增（治理 SSOT） |
| `docs/commercial-sync-backlog.md` | 文档新增（本文件） |

**sync 分支**：`sync/p0-lifecycle-status-and-docs`

**验证**：在 commercial-product 上跑 `npm run build && npm run check`，确认导出功能可用。

---

### PR-2 ｜ Progressive Validation + Off-Price 知识库 + Swim-lane

**目标**：把 3 个 P1/P2 [SHARED] 功能批量同步。

| 字段 | 值 |
|------|---|
| 状态 | `pending` |
| 优先级 | **P1**（Progressive Validation 主导）|
| 风险 | 低 — 需调整 demo seed 数据 |
| 含 Qimo-specific 数据 | ❌ |

**Sub-PR breakdown**（建议拆 3 个独立 sync 分支，避免 8 文件混合 review）：

#### PR-2a ｜ Progressive Validation
**sync 分支**：`sync/shared-progressive-validation`

| 文件 | 类型 |
|------|------|
| `app/orders/new/page.tsx` | UI: 5 字段去 required |
| `app/actions/orders.ts` | 后端：去硬校验 |
| `app/actions/milestones.ts` | hard-block at packing_method_confirmed / domestic_delivery |
| `lib/services/daily-tasks.service.ts` | missing_info 任务覆盖送货字段 |
| `app/orders/[id]/page.tsx` | 缺失送货信息 banner |

**验证**：在 commercial-product 演示流程中至少一个 `delivery_type='domestic'` 的 demo 订单，能在「包装方式确认」节点看到 hard-block 提示。

#### PR-2b ｜ Off-Price 知识库
**sync 分支**：`sync/shared-off-price`

| 文件 | 类型 |
|------|------|
| `lib/agent/industryKnowledge.ts` | 新增 5 个 Off-Price 常量 + 3 个 helper |
| `app/customers/page.tsx` | 客户列表 Off-Price 标签 + 月度横幅 |
| `docs/knowledge/off-price-playbook.md` | 新增完整 playbook |

**前置准备**：demo seed 至少 1 个客户名含 Off-Price 关键词（如 `[DEMO] Ross Sourcing` / `[DEMO] TJX Discovery`），否则标签不会出现。

**验证**：进 `/customers` 应看到顶部琥珀色月度横幅 + 至少 1 个客户卡带 🏷️ Off-Price 标签。

#### PR-2c ｜ Swim-lane filter
**sync 分支**：`sync/shared-swim-lane`

| 文件 | 类型 |
|------|------|
| `lib/domain/swimLane.ts` | 新增静态映射 + helpers |
| `components/OrderTimeline.tsx` | filter pills + per-milestone badge |

**前置观察期**：上线 main 后 ≥ 1 周（2026-05-22 后再 audit），收集业务/生产反馈，确认默认 lane 分配合理。

**验证**：
- 用 sales 角色登录 demo，进订单详情，默认看 16 节点；切「全部」可见 30 节点
- 用 admin 角色，默认看全部 30 节点
- 每个节点边上有 lane 标签

---

### PR-3 ｜ TODO(SoT) 注释包

**目标**：注释级同步，防止 commercial 维护者重蹈"以 OM 字段为收款 SoT"覆辙。

| 字段 | 值 |
|------|---|
| 状态 | `pending` |
| 优先级 | **P3** |
| 风险 | 极低（纯注释）|
| 含 Qimo-specific 数据 | ❌ |

**sync 分支**：`sync/shared-sot-comments`

**含 9 个文件**：

| 文件 | 标注数 |
|------|--------|
| `lib/runtime/deliveryConfidence.ts` | 1 |
| `lib/agent/customerProfile.ts` | 1 |
| `lib/agent/skills/riskAssessment.ts` | 1 |
| `lib/engine/orderDecisionRules.ts` | 3 |
| `lib/engine/blockRules.ts` | 1 |
| `lib/engine/rootCauseEngine.ts` | 1 |
| `lib/engine/orderDecisionEngine.ts` | 1 |
| `lib/engine/rules/causeRules/paymentCauses.ts` | 1 |
| `lib/engine/orderBusinessEngine.ts` | 1 |

**注意**：同步时需把注释中"（见 components/OrderActions.tsx 的重新同步按钮）"这类引用 finance-resync 的字样改写或删除，因为 finance-resync 本身不同步（默认 [INTERNAL]），否则在 commercial-product 上会形成悬空引用。

**验证**：`grep -rn "TODO(SoT)" lib/` 应返回 11 处标注。

---

## 不同步 — 明确登记

| 模块 | 类型 | 原因 |
|------|------|------|
| `app/actions/finance-resync.ts` | `[INTERNAL]` | 依赖 Qimo 内部财务系统 endpoint |
| `lib/integration/finance-sync.ts` | `[INTERNAL]` | 同上 |
| `app/api/integration/finance-callback/route.ts` | `[INTERNAL]` | 同上 |
| `app/api/integration/sync-all/route.ts` | `[INTERNAL]` | 同上 |
| `components/OrderActions.tsx` "重新同步" 按钮 | `[INTERNAL]` | 依赖以上 endpoint |
| `scripts/seed-demo-trade-os.ts` | `[COMMERCIAL]` | 反向：commercial-only，不进 main |

---

## 已完成（历史）

*（暂无）*

每完成一个 PR 应从「Pending 队列」移到此处，记录：
- merge commit on commercial-product
- merge 日期
- 验证结论

---

*最后更新：2026-05-15*
