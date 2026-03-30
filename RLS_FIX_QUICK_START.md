# 🚀 RLS 问题修复 - 快速执行指南

## ⚡ 立即执行（2步）

### 步骤 1：执行数据库迁移（必须）

1. 打开 Supabase Dashboard → SQL Editor
2. 打开文件：`supabase/migrations/20240121000001_init_order_milestones_function.sql`
3. 复制全部内容并粘贴到 SQL Editor
4. 点击 **Run** 执行

**验证函数创建成功：**
```sql
SELECT 
  routine_name,
  routine_type,
  security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name = 'init_order_milestones';
```

应该看到：
- `routine_name`: `init_order_milestones`
- `security_type`: `DEFINER` ✅

---

### 步骤 2：重启开发服务器

```bash
# 如果服务器正在运行，先停止（Ctrl+C）
cd /Users/ning/order-metronome
npm run dev
```

---

### 步骤 3：测试创建订单

1. 访问：http://localhost:3001/orders/new
2. 填写订单信息
3. 点击"下一步"
4. ✅ **应该成功，不再报 RLS 错误**

---

## ✅ 修复内容

### 已完成的代码修复

1. ✅ **创建数据库函数** - `init_order_milestones()`
   - 使用 `SECURITY DEFINER` 绕过 RLS
   - 接收订单ID和里程碑数据JSON
   - 自动处理角色映射和状态映射
   - 兼容两种表结构

2. ✅ **修改创建订单流程** - `app/actions/orders.ts`
   - 移除直接 `createMilestones()` 调用
   - 改为通过 RPC 调用数据库函数
   - 准备里程碑数据为 JSON 格式

3. ✅ **保留 RLS 策略**
   - 用户操作仍然受 RLS 保护
   - 只有系统函数可以绕过（通过 SECURITY DEFINER）

---

## 🎯 创建订单完整流程

```
Step 1: 创建订单
  ↓
createOrder() → createOrderRepo()
  ↓
订单创建成功 (lifecycle_status = '草稿')
  ↓
Step 2: 自动生成里程碑
  ↓
计算日期 → 准备数据 → RPC调用
  ↓
init_order_milestones() [SECURITY DEFINER]
  ↓
批量插入里程碑（绕过 RLS）
  ↓
里程碑创建成功
  ↓
Step 3: 执行说明
  ↓
Step 4: 进入执行
```

---

## 🐛 如果还有问题

### 问题 1：函数执行失败

**检查：**
1. 函数是否创建成功（执行验证 SQL）
2. 函数权限是否正确（`GRANT EXECUTE TO authenticated`）
3. 里程碑数据格式是否正确

### 问题 2：仍然报 RLS 错误

**检查：**
1. 确认函数使用 `SECURITY DEFINER`
2. 确认通过 RPC 调用，不是直接 insert
3. 检查浏览器控制台错误信息

### 问题 3：里程碑未生成

**检查：**
1. 查看服务器日志（RPC 调用是否成功）
2. 检查数据库是否有里程碑记录
3. 验证订单ID是否正确传递

---

## 📚 详细文档

- `RLS_FIX_DELIVERY.md` - 完整交付文档
- `supabase/migrations/20240121000001_init_order_milestones_function.sql` - 数据库函数

---

**执行完步骤 1-3 后，创建订单应该可以正常工作了！** ✅
