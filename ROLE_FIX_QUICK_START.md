# 🚀 角色枚举修复 - 快速执行指南

## ⚡ 立即执行（3步）

### 步骤 1：执行数据库迁移（必须）

1. 打开 Supabase Dashboard → SQL Editor
2. 打开文件：`supabase/migrations/FIX_user_role_enum_final.sql`
3. 复制全部内容并粘贴到 SQL Editor
4. 点击 **Run** 执行

**验证：**
```sql
SELECT e.enumlabel 
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname = 'user_role'
ORDER BY e.enumsortorder;
```

应该看到：`sales`, `finance`, `procurement`, `production`, `quality`, `admin`, `logistics`, `qc`

---

### 步骤 2：重启开发服务器

```bash
# 如果服务器正在运行，先停止（Ctrl+C）
# 然后重新启动
cd /Users/ning/order-metronome
npm run dev
```

---

### 步骤 3：测试创建订单

1. 访问：http://localhost:3001/orders/new
2. 填写订单信息
3. 点击"下一步"
4. ✅ **应该成功，不再报错**

---

## ✅ 修复内容

### 已完成的代码修复

1. ✅ **创建角色映射层** - `lib/domain/roles.ts`
   - 所有角色值统一映射
   - `logistics` → `logistics` (如果数据库支持) 或 `admin` (回退)
   - `qc` → `qc` (如果数据库支持) 或 `quality` (回退)

2. ✅ **修复 Repository 层** - `lib/repositories/milestonesRepo.ts`
   - 所有写入的 `owner_role` 自动通过 `normalizeRoleToDb` 映射
   - 禁止散落魔法字符串

3. ✅ **数据库迁移脚本** - `supabase/migrations/FIX_user_role_enum_final.sql`
   - 添加 `logistics` 和 `qc` 到枚举

---

## 🐛 如果还有问题

### 问题 1：迁移执行失败

**错误：** `cannot add new value to enum type in a transaction`

**解决：** PostgreSQL 的 `ALTER TYPE ADD VALUE` 不能在事务中执行，需要：
1. 确保不在事务块中执行
2. 或者分别执行两个 `ALTER TYPE` 语句

### 问题 2：迁移后仍然报错

**检查：**
1. 确认枚举值已添加（执行验证 SQL）
2. 确认开发服务器已重启
3. 检查浏览器控制台错误信息

### 问题 3：需要回退方案

如果数据库迁移无法执行，可以临时修改 `lib/domain/roles.ts`：

```typescript
export const ROLE_MAP_TO_DB: Record<AppRole, string> = {
  // ...
  'logistics': 'admin', // 强制回退到 admin
  'qc': 'quality', // 强制回退到 quality
  // ...
};
```

---

## 📚 详细文档

- `ROLE_FIX_SUMMARY.md` - 完整修复总结
- `ROLE_FIX_DELIVERY.md` - 详细交付文档

---

**执行完步骤 1-3 后，创建订单应该可以正常工作了！** ✅
