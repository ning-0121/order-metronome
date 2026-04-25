# Sprint 0 — TypeScript 技术债登记

> 创建：2026-04-25
> 状态：本仓库当前 **101 个 TS 错** 被 `next.config.ts` 的 `ignoreBuildErrors: true` 屏蔽
> 来源：Sprint 0 工程加固诊断（分支 `sprint-0-hardening`）

---

## 错误分类（共 101）

| TS 码 | 数量 | 含义 | 优先级 |
|------|------|------|------|
| TS2582 | 15 | 测试文件缺 `@types/jest`/`@types/node` | 🟢 低 |
| TS2345 | 19 | 类型不匹配（多为 supabase `.update({...})` 推断为 `never`） | 🟡 中 |
| TS2339 | 15 | 访问不存在属性（`profile.roles` 在 `never` 上） | 🟡 中 |
| TS2304 |  9 | 找不到符号（`expect`、`chainGenerated`） | 🟢/🔴 |
| TS2367 |  8 | 类型不重叠的比较 | 🔴 高（业务逻辑误判） |
| TS18047 |  8 | possibly null 访问 | 🔴 高（运行时崩溃源） |
| TS2353 |  4 | 对象多余字段（schema 错配） | 🟡 中 |
| 其余 | 23 | 杂项 | 混合 |

---

## P0 候选清单（真 bug，建议 Sprint 1 优先修）

| # | 文件:行 | 描述 | 影响 |
|---|--------|------|------|
| 1 | `lib/milestoneTemplate.ts:37` | `'production_manager'` 不在 `OwnerRole` 类型 | 角色组在 7+ 文件遗漏的根因 |
| 2 | `app/api/cron/agent-scan/route.ts:677` | `chainGenerated` 未定义却被引用 | cron 跑到该分支会 crash |
| 3 | `app/actions/orders.ts:281, 652` | `OrderType === 'repeat'` 类型不重叠 | 翻单逻辑可能从未生效 |
| 4 | `app/api/integration/finance-callback/route.ts:106` | `'milestone'` 不在允许字面量 | 财务回调里程碑分支永不进入 |
| 5 | `app/actions/procurement.ts:137-138` | `orderQuantity` 可能为 null 仍参与计算 | NaN 写入 DB 风险 |

---

## 待迁移 ROLE_GROUPS 的硬编码点（Sprint 1）

| 文件:行 | 现状 | 建议 group |
|---------|------|-----------|
| `app/actions/milestones.ts:~180` | `merchGroup = ['merchandiser','production','qc','quality']` | `ROLE_GROUPS.EXECUTION`（含 production_manager，行为变更需评估） |
| `app/actions/milestones.ts:1044, 1358` | `!includes('admin') && !includes('production_manager')` | 新增 `CAN_MANAGE_PROCUREMENT_PRICES` group |
| `app/actions/procurement.ts:41` | `ALLOWED_ROLES = [...]` | 新增 `CAN_VIEW_PROCUREMENT` group |
| `app/actions/procurement.ts:262` | `['merchandiser','procurement','admin']` | 同上 |
| `app/actions/orders.ts:924` | `['admin','finance']` | 新增 `CAN_MODIFY_ORDER_FINANCIAL` group |
| `app/actions/delay-hotspots.ts:235` | `['sales','merchandiser','procurement','finance','admin']` | 评估后定 group |
| `app/actions/execution-analytics.ts:93` | 包含 `'logistics'` | 评估，logistics 角色定义不全 |

---

## 待迁移 ActionResult 契约的 action（Sprint 1）

| Action | 行数 | 调用方 | 当前返回形态 |
|--------|------|--------|-------------|
| `markMilestoneDone` | 600+ | `MilestoneActions.tsx` | `{error?} \| {success?, cleared?} \| {data?}` 混合 |
| `createOrder` | 665 | `app/orders/new/page.tsx` | `{ok, orderId?, error?, warning?}` |
| ✅ `approveDelayRequest` | 185 | 3 个组件 | **已迁移**（Sprint 0），内部用 `ActionResult` + `toLegacyResult` 包装 |

---

## 关闭 `ignoreBuildErrors` 的路径

```
当前 (Sprint 0) → ignoreBuildErrors: true，101 错被忽略
       │
       ▼
Sprint 1：清 P0 候选清单 5 条 + 给测试文件补 @types/jest（≈消 23 错）
       │
       ▼
Sprint 2：迁移 markMilestoneDone / createOrder 到 ActionResult，消其相关错
       │
       ▼
Sprint 3：使用 supabase gen types 生成 Database 类型，消除 `never` 推断和 99% `as any`
       │
       ▼
Sprint 4：剩余错全部 // @ts-expect-error 标注 + TODO，关 ignoreBuildErrors
```

---

## 维护规则

1. 任何新增代码必须 0 TS 错，否则不允许合并
2. 新写 server action 必须返回 `ActionResult<T>`，不允许引入新 ad-hoc shape
3. 新写权限判断必须用 `ROLE_GROUPS` + `hasRoleInGroup`，不允许硬编码角色数组
4. 新写 page.tsx / 组件必须为可能为空的 prop 用 `??`/`?.` 守卫
