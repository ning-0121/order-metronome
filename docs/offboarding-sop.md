# 员工离职处理 SOP + 系统化方案（离职按钮）

> 适用：绮陌自用版 + 未来商用 SaaS 版（离职是高频事件，必须标准化、系统化）。
> 状态：SOP 已验证（2026-06-15 处理许继平/马鑫）；系统「离职按钮」待开发（设计见 §4）。

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

## 3. 已处理记录 + 残留

- **2026-06-15 许继平 / 马鑫离职**：未完成里程碑(约43)已转派给增富(qzf@qimoclothing.com)，profiles 已删。
- ⚠️ **残留**：当时**未封 auth 账号** → 两人理论上仍可登录(被当 sales)。**需补一步封号**：
  ```sql
  update auth.users set banned_until = 'infinity'
  where id in (select id from auth.users where email in ('许继平邮箱','马鑫邮箱'));
  -- profile 已删，需用邮箱定位；邮箱见离职前记录
  ```

---

## 4. 系统化方案：离职按钮（待开发）

把上面三步固化成一个 admin-only 操作，杜绝漏步（尤其封号）。

### 4.1 数据
- `profiles` 加 `active boolean NOT NULL DEFAULT true`（**停用而非删除** → 保留 name，历史节点 owner 仍能显示姓名）。
- 离职审计：写 `order_logs`/或新 `offboarding_log`（谁、何时、离职谁、转派给谁、影响数）。

### 4.2 Server Action `offboardUser(targetId, handoverToId, confirmName)`（仅 admin）
1. 校验：admin、不能离职自己、confirmName 与目标姓名一致（二次确认）。
2. 转派活跃工作：`milestones.owner_user_id`(未完成) + `orders.owner_user_id`(活跃) → handoverToId。
3. **封号**：service-role `auth.admin.updateUserById(targetId,{ban_duration:'876000h'})`（或 SQL `banned_until`）。
4. 停用：`profiles.active=false`、清空 roles。
5. 记审计日志。失败任一步整体报错，不留半成品。
6. 可逆：配套 `reactivateUser`（解封 + active=true）。

### 4.3 UI（UserRoleManager）
- 每个用户行：把现有「删除」替换/降级为 **「离职交接」** 按钮。
- 点击 → 弹窗：选**接手人**(下拉) + 输入姓名二次确认 → 调 `offboardUser`。
- 用户列表分「在职 / 已离职」两区；已离职区可「恢复」。
- 指派人选择器(`OwnerAssignment` 等)、`getAllUsers` 默认只列 `active=true`。

### 4.4 与"删除"的关系
保留一个 admin-only 的**彻底删除**(硬删 auth+历史)仅用于极端场景(如误建账号、合规要求)，且明确警告其代价；**离职默认走"交接+封号+停用"**，不走删除。

---

## 5. 商用 SaaS 版要点
- 离职按钮是通用能力，`[SHARED]`，不含任何绮陌专属。
- 角色驱动:转派目标按角色筛选(同岗位优先)。
- 每客户独立 Supabase → 各自的 auth/profiles 隔离，封号互不影响。
- 审计留存:离职/封号/转派全程留痕，满足合规。

---
*2026-06-15 落档。手动 SOP 已可用；离职按钮功能待确认后开发。*
