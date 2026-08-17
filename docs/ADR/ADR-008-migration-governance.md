# ADR-008 · MIGRATION-GOV-001:生产迁移的执行边界

**状态**:Accepted(2026-08-16,CEO 拍板)
**触发**:一次真实的意外生产迁移

---

## 背景:一次无害但性质严重的事故

2026-08-16,我在 `feat/procurement-generator-p0p1` 上新建了
`supabase/migrations/20260816_bom_allocation_mode.sql`。
与此同时,另一个 session(Cursor)把同一个 checkout 切到了 `fix/production-owner-field`,
并在那条分支上跑了 `npm run db:migrate`。

结果:**我那条还在开发中、没有任何人批准部署的迁移,被一起 apply 到了生产库。**

账本对得上:`db:status` 显示已执行 254,而我的 worktree 目录里只有 253 个文件
(差的一条是对方自己的 `20260815_add_production_owner.sql`)。

这次无害 —— nullable additive column、幂等、NULL 等同旧行为,而且正是我们要的那一列。
但**性质**是:生产 schema 在无人决策的时刻被改变了。

下一次可能是:`DROP` · constraint · RLS · index lock · 数据 backfill · enum change。

## 根因:branch isolation ≠ migration isolation

```
git 隔离的是        代码历史(commit / branch)
db:migrate 扫的是   当前 filesystem 的 supabase/migrations 目录
```

`db:migrate` 不认分支。**谁跑它,就把当时工作区里所有未执行的 .sql 打上生产。**
多 session / 多 agent 共用一个 checkout 时,这是一条隐形的生产写入通道。

因此这不是"以后大家记得用 worktree"能解决的纪律问题,而是工具边界问题。

## 决策

确立原则:

> **Production migration is an explicit deployment artifact,
> not a side effect of repository state.**

实现为**两道很窄的闸**(刻意不重构迁移框架):

### ① 静态闸 —— `lint:migrations`(与 `lint:data-access` 同级)

`supabase/migrations/APPROVED.json` 是显式批准清单。
`scripts/check-migration-approval.mjs` 断言:**目录里每个 .sql 都必须在清单里**。

于是"工作区里多出一个没人批准的迁移"在 `npm run check` 阶段就红,
不必等到有人手滑跑 `db:migrate`。已进 `check`,CI 与本地同一口径。

加新迁移的正确姿势:**在同一个 commit 里把文件名加进 APPROVED.json** —— 可评审、可追溯。

### ② 运行时闸 —— `db:migrate` preflight

执行前必须:

1. 完整列出 `📋 本次将执行以下 N 个 migration:……`;
2. 校验待执行集合 ⊆ 批准范围;
3. 只要有一个未批准 → **一个都不执行**(all-or-nothing,绝不"跳过它继续跑其余")。

一次性放行:`npm run db:migrate -- --approve <文件名>`,逐个点名,
**不支持通配、没有 `--all`**,且会提示补进 APPROVED.json。

## 后果

- 新增迁移多一步:改 APPROVED.json。这一步是**特性不是负担** —— 它把"要不要上生产"
  从文件系统状态变成一次显式的、可 review 的声明。
- 已执行的历史迁移**不删文件、不改内容**;清单与目录不一致同样报错。
- 多 session 并行仍建议 `git worktree` 隔离(见记忆 `parallel-session-branch-collision`),
  但**安全性不再依赖于人记得这么做**。

## 验证

闸必须真的会红才算数,已实测:

- 塞入 `29991231_stray_from_other_branch.sql` → `lint:migrations` FAIL 并点名文件;
- 同状态跑 `npm run db:migrate` → 列出计划后 ⛔ 拒绝,退出码 1,
  `db:status` 已执行数不变(**生产库未被触碰**);
- 移除该文件 → 两闸恢复通过。

## 不做什么

- 不重构迁移运行器(exec_sql / `_app_migrations` 机制原样保留);
- 不引入迁移锁、审批工作流、环境矩阵 —— 当前规模用不上;
- 不回头修改已执行迁移文件的内容或注释(见 ADR 内 quantity 语义的处理方式:
  历史注释错误在 canonical 代码与测试中登记,不改历史)。
