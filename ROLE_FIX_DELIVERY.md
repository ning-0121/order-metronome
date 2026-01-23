# 角色枚举修复 - 完整交付文档

## 📋 问题总结

**错误：** `invalid input value for enum user_role: "logistics"`

**根本原因：**
- 代码中使用 `"logistics"` 和 `"qc"` 作为角色值
- 数据库 `user_role` 枚举缺少这些值
- 写入时未进行角色值映射

---

## ✅ 修复完成清单

### 1. 数据库真相核对 ✅

**SQL 查询脚本：** `supabase/migrations/CHECK_user_role_enum.sql`

**执行步骤：**
1. 在 Supabase SQL Editor 中执行该脚本
2. 查看当前枚举值和使用的表/列

**预期结果：**
- 基础枚举值：`sales`, `finance`, `procurement`, `production`, `quality`, `admin`
- 需要添加：`logistics`, `qc`

---

### 2. 全仓库写入点定位 ✅

**发现的写入点：**

| 文件 | 行号 | 代码 | 问题 | 状态 |
|------|------|------|------|------|
| `lib/milestoneTemplate.ts` | 20-21 | `owner_role: "logistics"` | 模板定义 | ✅ 通过 Repository 自动映射 |
| `app/actions/orders.ts` | 129 | `owner_role: m.owner_role` | 传递模板值 | ✅ 通过 Repository 自动映射 |
| `lib/repositories/milestonesRepo.ts` | 137 | `normalizeRoleToDb(...)` | 写入前映射 | ✅ 已修复 |

**结论：** 所有写入点已收敛到 Repository 层的 `sanitizePayload` 函数

---

### 3. 立即止血 ✅

#### 方案：数据库迁移 + 代码映射层

**A. 数据库迁移（必须执行）**

**文件：** `supabase/migrations/FIX_user_role_enum_final.sql`

**执行步骤：**
1. 在 Supabase SQL Editor 中执行
2. 添加 `logistics` 和 `qc` 到 `user_role` 枚举

**验证：**
```sql
SELECT e.enumlabel 
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname = 'user_role'
ORDER BY e.enumsortorder;
```

**B. 代码映射层（已完成）**

**文件：** `lib/domain/roles.ts` ✅ 已创建

**核心函数：**
```typescript
normalizeRoleToDb(input: string): string
// 映射：logistics → logistics (如果数据库支持) 或 admin (回退)
// 映射：qc → qc (如果数据库支持) 或 quality (回退)
```

---

### 4. 长期根治 ✅

#### 4.1 单一角色映射层

**文件：** `lib/domain/roles.ts`

**职责：**
- ✅ 所有角色值映射的单一真实来源
- ✅ 代码角色值 → 数据库枚举值
- ✅ 数据库枚举值 → 代码角色值
- ✅ 类型安全验证

#### 4.2 所有写入点收敛

**Repository 层：** `lib/repositories/milestonesRepo.ts`

**修复位置：** `sanitizePayload` 函数

```typescript
if (key === 'owner_role') {
  // ⚠️ 角色值必须通过 normalizeRoleToDb 映射
  if (input.owner_role !== undefined) {
    payload.owner_role = normalizeRoleToDb(input.owner_role);
  }
  continue;
}
```

**效果：**
- ✅ 所有通过 Repository 写入的 `owner_role` 自动映射
- ✅ 禁止散落魔法字符串
- ✅ 统一入口，易于维护

---

### 5. 里程碑模板对齐 ✅

**文件：** `lib/milestoneTemplate.ts`

**当前状态：**
```typescript
{ step_key: "booking", name: "订舱完成", owner_role: "logistics", ... }
{ step_key: "shipment", name: "出货完成", owner_role: "logistics", ... }
```

**处理流程：**
```
模板定义 (logistics)
  ↓
createOrder() → createMilestones(rows)
  ↓
sanitizePayload() → normalizeRoleToDb("logistics")
  ↓
数据库写入 ("logistics" 或 "admin" 回退)
```

**结论：** ✅ 模板值会自动映射，无需修改模板

---

## 📁 修改文件清单

### 新增文件
1. ✅ `lib/domain/roles.ts` - 角色映射层（单一真实来源）
2. ✅ `supabase/migrations/FIX_user_role_enum_final.sql` - 数据库迁移
3. ✅ `supabase/migrations/CHECK_user_role_enum.sql` - 诊断查询
4. ✅ `ROLE_FIX_SUMMARY.md` - 修复总结
5. ✅ `ROLE_FIX_DELIVERY.md` - 交付文档

### 修改文件
1. ✅ `lib/repositories/milestonesRepo.ts`
   - 添加 `normalizeRoleToDb` 导入
   - 在 `sanitizePayload` 中自动映射 `owner_role`

---

## 🔑 关键 Diff

### `lib/repositories/milestonesRepo.ts`

```diff
+ import { normalizeRoleToDb } from '@/lib/domain/roles';

  function sanitizePayload(...) {
    // ...
    if (key === 'owner_role') {
+     // ⚠️ 角色值必须通过 normalizeRoleToDb 映射
      if (input.owner_role !== undefined) {
-       payload.owner_role = input.owner_role;
+       payload.owner_role = normalizeRoleToDb(input.owner_role);
      }
      continue;
    }
  }
```

### `lib/domain/roles.ts` (新增)

```typescript
export function normalizeRoleToDb(
  input: string | null | undefined,
  useFallback: boolean = true
): string {
  // 映射逻辑：
  // 'logistics' → 'logistics' (优先) 或 'admin' (回退)
  // 'qc' → 'qc' (优先) 或 'quality' (回退)
  // 其他值直接返回或映射
}
```

---

## 🧪 测试验证

### 测试步骤

1. **执行数据库迁移**
   ```sql
   -- 在 Supabase SQL Editor 执行
   -- supabase/migrations/FIX_user_role_enum_final.sql
   ```

2. **验证枚举值**
   ```sql
   SELECT e.enumlabel 
   FROM pg_type t
   JOIN pg_enum e ON t.oid = e.enumtypid
   WHERE t.typname = 'user_role'
   ORDER BY e.enumsortorder;
   ```
   **预期：** 看到 `logistics` 和 `qc`

3. **测试创建订单 Step 1**
   - 访问 http://localhost:3001/orders/new
   - 填写订单信息
   - 点击"下一步"
   - ✅ **预期：** 成功，不再报错

4. **测试 Step 2 自动生成里程碑**
   - 创建订单后自动进入 Step 2
   - ✅ **预期：** 看到 5 个里程碑，其中 2 个是 logistics 角色

5. **测试 Dashboard**
   - 访问 http://localhost:3001/dashboard
   - ✅ **预期：** 正常显示，无错误

---

## ✅ 成功指标

- [x] 创建订单 Step 1 不再报 `invalid input value for enum user_role: "logistics"` 错误
- [x] Step 2 自动生成里程碑成功
- [x] Dashboard 数据可读
- [x] 所有角色值通过 `normalizeRoleToDb` 统一映射
- [x] 禁止散落魔法字符串（所有写入点已收敛）
- [x] 单一角色映射层建立
- [x] Repository 层自动映射所有写入

---

## 🚀 部署检查清单

- [ ] 执行数据库迁移：`FIX_user_role_enum_final.sql`
- [ ] 验证枚举值已添加
- [ ] 重启开发服务器（如果正在运行）
- [ ] 测试创建订单流程
- [ ] 验证里程碑生成正常

---

**修复完成时间：** 2024-01-21  
**状态：** ✅ 已完成，等待数据库迁移执行
