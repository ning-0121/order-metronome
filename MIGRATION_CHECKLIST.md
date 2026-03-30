# ✅ 数据库迁移检查清单

## 当前状态

✅ **milestone_logs 表已修复**
- `order_id` 字段已存在
- 表结构正确

---

## 📋 下一步：执行生命周期迁移

### 步骤 1：执行生命周期迁移

1. 在 Supabase SQL Editor 中：
   - 点击 **New Query** 或创建新查询
   - 打开文件：`supabase/migrations/20240121000000_add_order_lifecycle.sql`
   - 复制**全部内容**
   - 粘贴到 SQL Editor
   - 点击 **Run** 执行

### 步骤 2：验证迁移成功

执行以下查询验证新字段和表：

```sql
-- 1. 检查 orders 表的新字段
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'orders'
AND column_name IN (
  'lifecycle_status',
  'activated_at',
  'terminated_at',
  'termination_type',
  'termination_reason',
  'termination_approved_by',
  'retrospective_required',
  'retrospective_completed_at'
)
ORDER BY column_name;
```

**预期结果：** 应该看到 8 个新字段

---

```sql
-- 2. 检查新表是否存在
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN (
  'order_logs',
  'cancel_requests',
  'order_retrospectives'
)
ORDER BY table_name;
```

**预期结果：** 应该看到 3 个新表

---

```sql
-- 3. 检查 order_logs 表结构
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'order_logs'
ORDER BY ordinal_position;
```

**预期结果：** 应该看到以下字段：
- `id` (uuid)
- `order_id` (uuid)
- `actor_user_id` (uuid)
- `action` (text)
- `from_status` (text)
- `to_status` (text)
- `note` (text)
- `payload` (jsonb)
- `created_at` (timestamptz)

---

```sql
-- 4. 检查 cancel_requests 表结构
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'cancel_requests'
ORDER BY ordinal_position;
```

---

```sql
-- 5. 检查 order_retrospectives 表结构
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'order_retrospectives'
ORDER BY ordinal_position;
```

---

## ✅ 迁移完成检查清单

- [ ] `orders` 表新增 8 个生命周期字段
- [ ] `order_logs` 表创建成功
- [ ] `cancel_requests` 表创建成功
- [ ] `order_retrospectives` 表创建成功
- [ ] 所有表的 RLS 策略已创建
- [ ] 所有索引已创建

---

## 🚀 迁移完成后

一旦验证所有迁移成功，就可以开始测试了：

1. **启动开发服务器**
   ```bash
   cd /Users/ning/order-metronome
   npm run dev
   ```

2. **按照测试指南测试**
   - 参考 `QUICK_TEST_V1.6.md` 进行快速测试
   - 或参考 `TEST_LIFECYCLE.md` 进行完整测试

---

## 🐛 如果遇到错误

### 错误：字段已存在
如果看到 "column already exists" 错误，说明该字段已经存在，可以安全忽略。

### 错误：表已存在
如果看到 "relation already exists" 错误，说明表已经创建，可以安全忽略。

### 错误：约束冲突
检查是否有数据违反新的约束条件，需要先清理数据。

---

**提示：** 如果迁移过程中遇到任何错误，请检查错误信息并告诉我，我会帮你解决。
