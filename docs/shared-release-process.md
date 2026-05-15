# Shared Release Process — main ↔ commercial-product 同步制度

> 这份文件定义 **main**（Qimo 内部生产）与 **commercial-product**（对外 SaaS）之间的代码同步规则。
> 一切跨分支同步行为以此文档为准。

---

## 1. 目的与第一原则

### 1.1 Shared Core 是唯一事实来源（SSOT）

**Shared Core 的所有改动只能从 `main` 流向 `commercial-product`**，反方向被禁止。

```
        ┌─────────────────────────────────┐
        │   main (internal production)    │  ← Shared Core SSOT
        │   ─────────────────────────     │
        │   .  [INTERNAL] 模块             │
        │   .  [SHARED]   模块  ──┐        │
        └─────────────────────────│───────┘
                                  │
                          sync/shared-* (review-gated)
                                  │
        ┌─────────────────────────▼───────┐
        │   commercial-product (SaaS)     │
        │   ─────────────────────────     │
        │   .  [SHARED]      ←接收          │
        │   .  [COMMERCIAL] 模块           │
        └─────────────────────────────────┘
```

### 1.2 commercial-product 不是 fork 产品

commercial-product **不是** main 的副本或分叉。它是一个**消费 Shared Core 的下游产品**，自身只允许新增/修改 `[COMMERCIAL]` 类目的代码。

### 1.3 禁止复制粘贴式演化

任何 "在 commercial-product 上手动改一下 Shared Core 文件" 的行为视为**违规**。
理由：双侧手改 → 后续 merge 必然冲突 → 工程师采用"哪边新就保留哪边"的低质量决策 → 长期分叉失控。

---

## 2. 功能分类规则

每个模块必须打且只打一个标签：

| 标签 | 含义 | 允许位置 | 同步方向 |
|------|------|---------|---------|
| `[INTERNAL]` | 绑定 Qimo 内部业务流程/客户/工厂/账号 | 仅 main | **不同步** |
| `[SHARED]` | 通用执行逻辑，不含任何 Qimo-specific 数据 | main + commercial-product（**两侧字节相同**）| main → commercial（单向）|
| `[COMMERCIAL]` | 对外 SaaS 独有：demo seed、tenant 隔离、billing、onboarding 等 | 仅 commercial-product | **不反向同步** |

### 2.1 判定流程图

```
新模块准备入库
   │
   ├─ 含 Qimo 客户名 / 内部 endpoint / 内部账号？ ──Yes──→  [INTERNAL]
   │                                                        放 main，不同步
   ├─ 是否仅服务 SaaS 演示 / 多租户 / billing？ ───Yes──→  [COMMERCIAL]
   │                                                        放 commercial-product
   │
   └─ 通用执行逻辑，且通过 Qimo-specificity 审计？ ──Yes──→ [SHARED]
                                                            放 main，单向同步
```

### 2.2 Qimo-specificity 审计清单

模块要标 `[SHARED]` 必须通过：

- [ ] 不含 Qimo 客户名（年年旺 / EHL / Habib / ...）
- [ ] 不含 Qimo 工厂名 / 邮箱域 / 内部 endpoint
- [ ] 不依赖 Qimo 内部 env var（如 `FINANCE_SYSTEM_URL`）
- [ ] 不依赖 Qimo 专有数据库表（如内部财务系统的 BO- 单号）
- [ ] 文案与术语在外贸行业属通用表达

任一不通过 → 必须标 `[INTERNAL]`。

---

## 3. Shared 模块晋升流程

新模块要变成 `[SHARED]` 必须走完 5 个阶段：

```
[1] internal validated      在 main 至少运行 7 天，无 P0/P1 bug
       │
       ▼
[2] registry 登记            shared-core-registry.md 新增条目
       │                    填齐：路径 / 触发节点 / 规则 / override / Qimo 专属性
       ▼
[3] sync audit              对照本文档第 2.2 节，确认无 Qimo-specific 数据
       │                    输出审计结论附在 registry 条目
       ▼
[4] staged release          创建 sync/shared-<module> 分支，merge 到 commercial-product
       │
       ▼
[5] demo verification       在 commercial-product 上跑一遍 demo 流程
                            确认演示路径无回归
```

**任何阶段失败 → 退回到该阶段前，不允许跳过。**

特别注意：
- 阶段 [2] 是**强制**的。没有 registry 登记的代码改动，即使纯通用，也不能算 `[SHARED]`。
- 阶段 [5] 失败的常见原因：demo seed 不匹配新逻辑（如 Off-Price 标签因 demo 客户名不命中而看不到）。

---

## 4. 同步优先级规则

按这个顺序排队。同一批次内可多个并行，跨批次不可逾越：

| 优先级 | 类目 | 说明 | 典型示例 |
|--------|------|------|---------|
| **P0** | Bug fixes (production) | main 已修，commercial 仍有问题，演示会复现 | `lifecycle_status` 列名修复 |
| **P1** | Shared logic | 通用业务逻辑，影响演示价值 | Progressive Validation |
| **P2** | Knowledge layer | 行业知识库 / 文档 / playbook | Off-Price playbook |
| **P3** | SoT annotations | 纯注释，0 风险 | `TODO(SoT)` 标注包 |
| **N/A** | External integrations | **不同步**（属于 [INTERNAL] 或需重构）| finance-resync |

---

## 5. 当前模块归类（明示）

| 模块 | 分类 | 备注 |
|------|------|------|
| **delivery-info-progressive-validation** | `[SHARED]` | 通用骨架，无 Qimo 数据。优先级 P1。 |
| **Off-Price knowledge** | `[SHARED]` | 行业方法论，无 Qimo 客户名。优先级 P2。 |
| **TODO(SoT) 注释** | `[SHARED]` | **必须同步**，避免 commercial 维护者重蹈"以 OM 字段为收款 SoT"覆辙。优先级 P3。 |
| **computeTaskPriority / escalateStaleTasks** | `[SHARED]` | 纯函数 / 通用 cron 逻辑 |
| **delivery_confidence 引擎** | `[SHARED]` | 算法通用，参数为默认值 |
| **customer_rhythm SoT 模式** | `[SHARED]` | nightly cron + 标签集 |
| **finance-resync 三件套** | `[INTERNAL]` | 默认不同步。依赖 `FINANCE_SYSTEM_URL` 等 Qimo env。未来若 commercial 客户付费要接财务系统，应重构为「可配置 webhook 模板」再晋升 `[SHARED]`。 |
| **Qimo 财务集成 webhook** | `[INTERNAL]` | 永久 INTERNAL |
| **`scripts/seed-demo-trade-os.ts`** | `[COMMERCIAL]` | 演示专用，不反向进 main |
| **Qimo 客户画像页面** (`/customers` Qimo 数据) | `[INTERNAL]` | 真实客户名属商业机密 |

---

## 6. 分支模型与 PR 模式

### 6.1 分支三层结构

```
main                       Qimo 内部生产，所有 [SHARED] 的 SSOT
│
├── sync/shared-<name>     从 main 切出，每个 [SHARED] 批次一个分支
│                           只允许包含通过 sync audit 的文件
│
└── commercial-product     SaaS 产品分支，通过 merge sync/* 接收 Shared Core
                           只允许在此新增/修改 [COMMERCIAL] 模块
```

### 6.2 sync 分支命名规范

```
sync/shared-progressive-validation     ← delivery-info 整套
sync/shared-off-price                   ← Off-Price playbook + 常量 + UI
sync/shared-sot-comments                ← 9 个文件的 TODO(SoT) 注释包
sync/p0-lifecycle-status                ← P0 bug 修复，特殊前缀
```

规则：
- 分支名一律 `sync/<priority>-<module>` 或 `sync/shared-<module>`
- 一个 sync 分支只装一个逻辑批次（不混 P0 修复和 P2 文档）
- merge 到 commercial-product 用 `--no-ff` 强制留下 merge commit，便于追溯

### 6.3 同步动作清单

每个 sync/* 分支 merge 前必须满足：

- [ ] 仅包含 `[SHARED]` 文件（grep 验证无 Qimo 客户名 / 内部 endpoint）
- [ ] 在 commercial-product 上 `npm run build && npm run check` 通过
- [ ] 在 commercial-product 上跑一遍核心 demo 流程
- [ ] `shared-core-registry.md` 已更新 `synced_to_commercial = ✅` + `last_sync_commit = <sha>`
- [ ] `commercial-sync-backlog.md` 对应 backlog 项移到「已完成」

---

## 7. Release Cadence

| 频率 | 内容 | 触发条件 |
|------|------|---------|
| **即时** | P0 bug fixes | 演示前发现 / 生产复现 |
| **每周** | Shared sync 例行 | 每周三跑一次 audit，把过去 7 天的 main 变更评估是否要 sync |
| **演示前 ≥ 3 天** | Demo verification | 跑完整 demo 路径，确认无回归 |
| **每季** | Shared Core 整体审计 | 检查是否有 [SHARED] 误标，是否有长期 backlog 没消化 |

**Weekly Sync Checklist**：

```
1. git log main ^commercial-product 看本周 main 新增
2. 每个新 commit 标签为 INTERNAL / SHARED / COMMERCIAL
3. SHARED 部分追加到 commercial-sync-backlog.md
4. 按优先级打包成 sync/* 分支
5. merge 到 commercial-product
6. 更新 registry 的 sync 字段
```

---

## 8. 禁止事项

### 8.1 流程禁忌

| 禁忌 | 后果 | 替代方案 |
|------|------|---------|
| ❌ 长期手工 cherry-pick | commit 历史碎片化，无法追溯哪些 [SHARED] 已同步 | 用 `sync/shared-*` 分支 + merge |
| ❌ commercial-product 自行修改 [SHARED] 文件 | 双侧分叉，下次 sync 必冲突 | 改动先回 main，走 5 阶段晋升流程 |
| ❌ 给 `[SHARED]` 模块塞 Qimo 客户名/工厂名 | 商业机密泄露，外部演示翻车 | 重构为参数化，或重新分类为 `[INTERNAL]` |
| ❌ 跳过 registry 登记直接 sync | 后续无人能 audit | 必须先登记 |
| ❌ 跨优先级合并到同一个 sync/* 分支 | P0 等 P3 文档 review，演示前来不及发 | 一分支一批次 |

### 8.2 数据禁忌

`[SHARED]` 模块代码内**禁止出现**：

- 真实客户名（年年旺、EHL、Habib、Lit26、PITCH 等）
- 真实工厂名 / 邮箱域
- 真实金额 / PO 号 / 内部 BO- 单号
- Qimo 内部 endpoint（`order.qimoactivewear.com` / 内部财务系统 URL）
- Qimo 员工姓名 / 邮箱

发现违规：**立即把该模块降级为 `[INTERNAL]`**，不允许"留着但脱敏"。

---

## 9. 异常与例外

### 9.1 紧急绕过

如果生产 P0 bug 在演示前 1 小时被发现，允许：
- 直接在 main 改
- 直接 merge 同一 commit 到 commercial-product（不走 sync/*）
- 但**事后 24 小时内必须补登记**到 registry + backlog

不允许长期使用此通道。

### 9.2 模块降级

`[SHARED]` 因后续发现 Qimo-specific 而需降级为 `[INTERNAL]`：
1. 在 main 上从 [SHARED] 文件中**抽出** Qimo-specific 部分到 [INTERNAL] 文件
2. 保留可通用部分仍为 [SHARED]
3. commercial-product 上**手动删除**降级部分（这是唯一允许 commercial 主动改 Shared Core 的场景）
4. 更新 registry 标注降级原因

---

## 10. 责任分工

| 角色 | 职责 |
|------|------|
| **CEO（你）** | 决定模块分类、批准 sync 批次、定 release cadence |
| **Claude（我）** | 每周跑 audit、维护 registry、写 sync/* 分支、写演示验证脚本 |
| **Cursor** | 写业务代码时主动声明 INTERNAL/SHARED/COMMERCIAL，遵守第 8 节禁忌 |

---

## 11. 相关文档

- [shared-core-registry.md](./shared-core-registry.md) — 所有 [SHARED] 模块的清单 + 同步状态
- [commercial-sync-backlog.md](./commercial-sync-backlog.md) — 待同步的 PR 列表
- [product-boundary.md](./product-boundary.md) — 内部/商业产品边界
- [execution-engine.md](./execution-engine.md) — 含 Progressive Validation 章节

---

*创建：2026-05-14 | 维护：CEO + Claude | 版本：v1*
