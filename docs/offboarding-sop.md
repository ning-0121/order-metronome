# 员工离职处理 SOP + 系统化方案（离职按钮）

> 适用：绮陌自用版 + 未来商用 SaaS 版（离职是高频事件，必须标准化、系统化）。
> 状态：SOP 已验证（2026-06-15 处理许继平/马鑫）；**系统「离职按钮」已上线（2026-06-17）**，实现见 §4。
> 日常离职 → 直接用 `/admin/users` 的「离职交接」按钮；手动 SQL（§2）仅作兜底/无 UI 时参考。

---

## 1. 核心原则（为什么不能"硬删"）

离职处理 = **转派活跃工作 + 封锁登录 + 移出花名册**，三件事缺一不可。**绝不硬删 auth 用户。**

| 坑 | 事实 |
|----|------|
| **硬删 auth 会被外键挡** | `auth.users` 被 ~80 个 `NO ACTION` 外键引用(orders/milestones/attachments/各种 created_by/approved_by/actor…)。删用户要逐个 nullify 这些列，且**篡改/丢失审计历史**。仅 7 张表 CASCADE、5 列 SET NULL。 |
| **只删 profile 拦不住登录** | middleware 只校验「已登录 + 邮箱 @qimoclothing.com」，**不查 profile**。删了 profile 的人，auth 账号仍在 → 仍能登入并被当作默认 `sales`。**必须封 auth 账号才能真正阻止访问。** |
| **app 的「删除」按钮有坑** | `deleteUser` 是"先删 profile 再删 auth"，auth 删除一旦被外键挡住 → 留下"有 auth 无 profile"的坏账。**离职不要用它。** |

**正确机制 = 封号(ban auth) + 停用 profile**：保留 auth 行与全部历史、零外键连锁、可逆。

---

## 2. 标准操作流程（手动，SQL Editor）

> 前提：先确认接手人角色已配置好（如 增富 = 理单/订单执行 + 生产主管）。

**Step 1 — 摸清离职者工作引用面（只读）**：查 `orders.owner_user_id/created_by`、`milestones.owner_user_id`(未完成) 等。

**Step 2 — 守卫式转派 + 停用 + 封号**（一段事务，计数校验，不符回滚）：
```sql
DO $$
DECLARE v_to uuid; v_leavers uuid[]; v_ms int; v_ord int;
BEGIN
  select user_id into v_to from public.profiles where email = '接手人邮箱';
  if v_to is null then raise exception '找不到接手人'; end if;
  select array_agg(user_id) into v_leavers from public.profiles where name in ('离职人1','离职人2');
  if coalesce(array_length(v_leavers,1),0) = 0 then raise exception '未匹配到离职人'; end if;

  -- 转派活跃工作（未完成节点 + 活跃订单 owner）→ 接手人；已完成保留原 owner 作历史
  update public.milestones set owner_user_id=v_to, updated_at=now()
    where owner_user_id = any(v_leavers) and actual_at is null;
  get diagnostics v_ms = row_count;
  update public.orders set owner_user_id=v_to
    where owner_user_id = any(v_leavers)
      and lifecycle_status not in ('completed','已完成','cancelled','已取消','archived','已归档');
  get diagnostics v_ord = row_count;

  -- 封锁登录（关键！）：ban auth 账号，保留行与历史、可逆
  update auth.users set banned_until = 'infinity' where id = any(v_leavers);

  -- 移出花名册（软停用优先；当前无 active 列则删 profile 行）
  delete from public.profiles where user_id = any(v_leavers);

  raise notice '✅ 转派节点% / 订单% → 接手人；已封号 + 移出花名册', v_ms, v_ord;
END $$;
```

**Step 3 — 验证**：离职者从用户列表消失；接手人名下未完成节点增加;`select banned_until from auth.users where id=...` 不为空。

---

## 3. 已处理记录

- **2026-06-15 许继平 / 马鑫离职**：未完成里程碑(约43)已转派给增富(qzf@qimoclothing.com)，profiles 已删。
- **2026-06-17 补封号（残留已闭环）**：两人当时漏封 auth → 仍能登录(被当 sales)。已用守卫式 SQL 锁定"有 auth 无 profile"的 2 个孤儿账号(mxin@ / xujiping@qimoclothing.com)并 `banned_until = 'infinity'`，验证两行均为 infinity。许/马登录已封死。
  > 教训：这正是"只删 profile 不封号"的坑(§1)，已由 §4 离职按钮固化为一步到位，杜绝再漏。

---

## 4. 系统化方案：离职按钮（✅ 已上线 2026-06-17）

把上面三步固化成一个 admin-only 操作，杜绝漏步（尤其封号）。实现文件见文末。

### 4.1 数据 — `supabase/migrations/20260617_profiles_active_offboarding.sql`
- `profiles.active boolean NOT NULL DEFAULT true`（**停用而非删除** → 保留 name，历史节点 owner 仍能显示姓名）。
- `profiles.departed_at timestamptz`、`profiles.handover_to uuid`（审计：离职时间、转派给谁；handover_to 不加 FK，避免外键连锁）。
- 索引 `idx_profiles_active`。**纯加列、幂等、无数据破坏；部署前在 Supabase SQL Editor 执行。**

### 4.2 Server Action `offboardUser(targetId, handoverToId, confirmName)`（仅 admin，`app/actions/users.ts`）
1. 校验：admin、不能离职自己、接手人非本人且在职、confirmName 与目标姓名一致（二次确认）。
2. 转派活跃工作（service-role）：`milestones.owner_user_id`(actual_at is null=未完成) + `orders.owner_user_id`(非 completed/archived/cancelled) → handoverToId；返回转派条数。
3. **封号**：`auth.admin.updateUserById(targetId,{ban_duration:'876000h'})`（~100 年）。
4. 停用：`profiles.active=false` + `departed_at=now()` + `handover_to`。
5. 失败任一步即返回错误并停止（已完成的步骤不回退，但顺序保证最关键的封号在停用前；可重跑——幂等校验"已离职"会拦）。
6. 可逆：配套 `reactivateUser(targetId)`（`ban_duration:'none'` 解封 + `active=true` + 清 departed_at；不自动收回已转派工作）。

### 4.3 UI（`components/UserRoleManager.tsx`）
- 在职行：用 **「离职交接」**(橙) 按钮替代原「删除」。点击 → 内联面板：选**接手人**(下拉，仅在职) + 输入姓名二次确认 → 调 `offboardUser`，完成弹转派条数。
- 列表分 **「在职 / 已离职」** 两区；已离职区灰显划线 + 显示离职日期/交接给谁 + **「恢复在职」** 按钮。
- `getAllUsers` 默认只返回 `active!==false`（含缺列降级容错）→ `OwnerAssignment` 等所有指派下拉自动屏蔽离职者。`admin/users` 页查全量(含离职字段)分区展示。

### 4.4 与"删除"的关系
**彻底删除**(硬删 auth+历史) 降级为离职面板里的小号红字按钮，仅用于误建账号等极端场景并明确警告其代价；**常规离职一律走「离职交接」**(可保留历史、可恢复)。

### 4.5 实现文件清单
- `supabase/migrations/20260617_profiles_active_offboarding.sql`（加列）
- `app/actions/users.ts`（`offboardUser` / `reactivateUser` / `getAllUsers` 过滤 active）
- `app/admin/users/page.tsx`（查离职字段，降级容错）
- `components/UserRoleManager.tsx`（在职/已离职分区 + 离职交接/恢复 UI）

---

## 5. 商用 SaaS 版要点
- 离职按钮是通用能力，`[SHARED]`，不含任何绮陌专属。
- 角色驱动:转派目标按角色筛选(同岗位优先)。
- 每客户独立 Supabase → 各自的 auth/profiles 隔离，封号互不影响。
- 审计留存:离职/封号/转派全程留痕，满足合规。

---
*2026-06-15 落档。手动 SOP 已可用；离职按钮功能待确认后开发。*
