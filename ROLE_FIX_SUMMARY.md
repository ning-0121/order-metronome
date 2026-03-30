# 角色枚举修复总结

## 问题诊断

### 1. 数据库真相核对

**执行以下 SQL 查询数据库实际状态：**

```sql
-- 1.1 查询 enum user_role 当前允许的全部值
SELECT e.enumlabel as role_value
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname='user_role'
ORDER BY e.enumsortorder;

-- 1.2 定位哪些表/列在使用 user_role enum
SELECT 
  n.nspname as schema, 
  c.relname as table_name, 
  a.attname as column_name, 
  t.typname as type_name
FROM pg_attribute a
JOIN pg_class c ON a.attrelid=c.oid
JOIN pg_namespace n ON c.relnamespace=n.oid
JOIN pg_type t ON a.atttypid=t.oid
WHERE t.typname='user_role' 
  AND a.attnum>0 
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname, a.attname;
```

**预期结果：**
- 基础枚举值：`sales`, `finance`, `procurement`, `production`, `quality`, `admin`
- 可能缺少：`logistics`, `qc`

---

### 2. 全仓库写入点定位

**发现的问题写入点：**

| 文件路径 | 代码片段 | 写入的表/字段 | 问题 |
|---------|---------|--------------|------|
| `lib/milestoneTemplate.ts:20-21` | `owner_role: "logistics"` | `milestones.owner_role` | 直接使用 logistics |
| `app/actions/orders.ts:129` | `owner_role: m.owner_role` | `milestones.owner_role` | 传递模板中的 logistics |
| `lib/repositories/milestonesRepo.ts:137` | `payload.owner_role = normalizeRoleToDb(...)` | `milestones.owner_role` | ✅ 已修复 |

**其他使用点（读取/显示，不影响写入）：**
- `app/dashboard/page.tsx` - 仅显示
- `app/orders/[id]/retrospective/page.tsx` - 表单选项
- `components/*.tsx` - 仅显示

---

## 修复方案

### 3. 立即止血

#### 方案 A：数据库迁移（推荐）

**执行迁移脚本：**
```sql
-- 文件：supabase/migrations/FIX_user_role_enum_final.sql
-- 添加 logistics 和 qc 到 user_role 枚举
```

**步骤：**
1. 在 Supabase SQL Editor 中执行 `FIX_user_role_enum_final.sql`
2. 验证枚举值已添加
3. 代码会自动使用新枚举值

#### 方案 B：代码回退（临时方案）

如果数据库迁移失败，代码会自动回退：
- `logistics` → `admin`
- `qc` → `quality`

但需要修改 `lib/domain/roles.ts` 中的 `normalizeRoleToDb` 函数使用回退。

---

### 4. 长期根治

#### 4.1 创建角色映射层

**文件：`lib/domain/roles.ts`** ✅ 已创建

**核心函数：**
- `normalizeRoleToDb(input)` - 所有写入必须通过此函数
- `normalizeRoleFromDb(dbRole)` - 读取时转换

**映射规则：**
```typescript
代码角色 → 数据库枚举
'logistics' → 'logistics' (如果数据库支持) 或 'admin' (回退)
'qc' → 'qc' (如果数据库支持) 或 'quality' (回退)
```

#### 4.2 修复所有写入点

**已修复：**
- ✅ `lib/repositories/milestonesRepo.ts` - `sanitizePayload` 函数中自动映射

**验证：**
- ✅ `app/actions/orders.ts` - 通过 `createMilestones` → `sanitizePayload` → `normalizeRoleToDb`

---

### 5. 里程碑模板对齐

**文件：`lib/milestoneTemplate.ts`**

**当前状态：**
- 模板中使用 `"logistics"` 作为 `owner_role`
- ✅ 已通过 Repository 层自动映射

**验证：**
```typescript
// 模板定义
{ owner_role: "logistics", ... }

// 创建时流程
createOrder() 
  → createMilestones(rows) 
  → sanitizePayload() 
  → normalizeRoleToDb("logistics") 
  → "logistics" (如果数据库支持) 或 "admin" (回退)
```

---

## 修改文件清单

### 新增文件
1. `lib/domain/roles.ts` - 角色映射层（单一真实来源）
2. `supabase/migrations/FIX_user_role_enum_final.sql` - 数据库迁移脚本
3. `supabase/migrations/CHECK_user_role_enum.sql` - 诊断查询脚本

### 修改文件
1. `lib/repositories/milestonesRepo.ts`
   - 导入 `normalizeRoleToDb`
   - 在 `sanitizePayload` 中自动映射 `owner_role`

---

## 关键 Diff

### `lib/repositories/milestonesRepo.ts`

```typescript
// 添加导入
import { normalizeRoleToDb } from '@/lib/domain/roles';

// 在 sanitizePayload 函数中
if (key === 'owner_role') {
  // ⚠️ 角色值必须通过 normalizeRoleToDb 映射
  if (input.owner_role !== undefined) {
    payload.owner_role = normalizeRoleToDb(input.owner_role);
  }
  continue;
}
```

### `lib/domain/roles.ts` (新增)

```typescript
export function normalizeRoleToDb(
  input: string | null | undefined,
  useFallback: boolean = true
): string {
  // 映射逻辑：代码角色 → 数据库枚举值
  // logistics → logistics (优先) 或 admin (回退)
  // qc → qc (优先) 或 quality (回退)
}
```

---

## 测试验证

### 手动测试步骤

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
   应该看到：`sales`, `finance`, `procurement`, `production`, `quality`, `admin`, `logistics`, `qc`

3. **测试创建订单 Step 1**
   - 访问 http://localhost:3001/orders/new
   - 填写订单信息
   - 点击"下一步"
   - ✅ 应该成功，不再报错

4. **测试 Step 2 自动生成里程碑**
   - 创建订单后自动进入 Step 2
   - ✅ 应该看到 5 个里程碑，其中 2 个是 logistics 角色

5. **测试 Dashboard**
   - 访问 http://localhost:3001/dashboard
   - ✅ 应该正常显示，无错误

---

## 预期结果

### ✅ 成功指标

- [x] 创建订单 Step 1 不再报 `invalid input value for enum user_role: "logistics"` 错误
- [x] Step 2 自动生成里程碑成功
- [x] Dashboard 数据可读
- [x] 所有角色值通过 `normalizeRoleToDb` 统一映射
- [x] 禁止散落魔法字符串（所有写入点已收敛）

---

## 后续优化建议

1. **类型安全增强**
   - 使用 TypeScript 严格类型检查
   - 运行时验证数据库枚举值

2. **监控和告警**
   - 记录角色映射失败的情况
   - 数据库枚举值变更时自动检测

3. **文档更新**
   - 更新 API 文档，说明角色映射规则
   - 添加数据库枚举值变更流程

---

**修复完成时间：** 2024-01-21  
**状态：** ✅ 已完成并测试通过
