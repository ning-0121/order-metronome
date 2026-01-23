# 🧪 V1.6 快速测试指南

## 📋 测试前准备

### 1. 执行数据库迁移（必须）

在 Supabase SQL Editor 中执行迁移文件：

1. 登录 [Supabase Dashboard](https://app.supabase.com)
2. 选择你的项目
3. 进入 **SQL Editor**
4. 点击 **New Query**
5. 复制并粘贴 `supabase/migrations/20240121000000_add_order_lifecycle.sql` 的全部内容
6. 点击 **Run** 执行

**验证迁移成功：**
- 检查 `orders` 表是否有新字段：`lifecycle_status`, `activated_at`, `terminated_at` 等
- 检查是否有新表：`order_logs`, `cancel_requests`, `order_retrospectives`

### 2. 启动开发服务器

```bash
cd /Users/ning/order-metronome
npm run dev
```

访问：**http://localhost:3000**

---

## 🎯 快速测试流程（5分钟）

### 步骤 1：创建订单（草稿状态）

1. 访问 **http://localhost:3000/orders/new**
2. 填写订单信息：
   - 客户名称：测试客户
   - 贸易条款：FOB
   - ETD：选择一个未来日期
   - 订单类型：sample
   - 包装类型：standard
3. 点击提交

**✅ 验证：**
- 订单创建成功
- 订单详情页显示生命周期条，当前状态为 **"草稿"**
- 显示 **"✅ 激活订单（进入执行）"** 按钮

---

### 步骤 2：激活订单

1. 在订单详情页点击 **"✅ 激活订单（进入执行）"** 按钮
2. 等待页面刷新

**✅ 验证：**
- 生命周期条更新，状态变为 **"已生效"** 或 **"执行中"**
- "激活订单"按钮消失
- 第一个里程碑自动变为 **"进行中"**

---

### 步骤 3：推进里程碑

1. 在订单详情页的执行时间线中
2. 点击某个里程碑的 **"完成"** 按钮

**✅ 验证：**
- 里程碑状态成功从"进行中"变为"已完成"
- 下一个里程碑自动推进为"进行中"

---

### 步骤 4：完成订单（测试完成流程）

**前置条件：** 确保所有里程碑都已完成

1. 如果还有未完成的里程碑，先完成它们
2. 在订单详情页点击 **"✅ 结案（完成订单）"** 按钮

**✅ 验证：**
- 订单状态变为 **"已完成"**
- 如果 `retrospective_required=true`，订单自动进入 **"待复盘"** 状态
- 生命周期条显示 **"待复盘"**

---

### 步骤 5：提交复盘

1. 在订单详情页点击 **"去复盘（必做）"** 按钮
   或直接访问：`/orders/[订单ID]/retrospective`
2. 填写复盘表单：
   - **是否准时交付**：选择"是"或"否"
   - **关键问题**：填写测试问题
   - **根本原因**：填写测试原因
   - **做得好的地方**：填写测试内容
   - **改进措施**：至少添加1条
     - 改进措施：填写测试措施
     - 负责人角色：选择角色
3. 点击 **"提交复盘"**

**✅ 验证：**
- 订单状态变为 **"已复盘"**
- 返回订单详情页，生命周期条显示 **"已复盘"**
- Dashboard 中待复盘模块不再显示该订单

---

## 🔒 测试入口封死点

### 测试 1：草稿状态不能修改里程碑

1. 创建一个新订单（草稿状态）
2. 尝试点击里程碑的"完成"按钮

**✅ 预期：** 操作被拦截，显示错误提示："订单状态为'草稿'，无法修改里程碑..."

---

### 测试 2：未完成里程碑不能结案

1. 选择一个执行中的订单
2. 确保还有未完成的里程碑
3. 尝试点击"结案"按钮

**✅ 预期：** "结案"按钮置灰，提示："仍有未完成执行步骤，无法结案"

---

### 测试 3：待复盘订单在 Dashboard 显示

1. 完成一个订单（进入待复盘状态）
2. 访问 **http://localhost:3000/dashboard**

**✅ 预期：** Dashboard 顶部显示 **"📋 待复盘订单"** 模块（紫色高亮）

---

## 🐛 常见问题排查

### 问题 1：激活订单后状态没有变化

**检查：**
1. 数据库迁移是否执行成功
2. 浏览器控制台是否有错误
3. 检查 Supabase 中 `orders` 表的 `lifecycle_status` 字段

**解决：**
```sql
-- 在 Supabase SQL Editor 中检查
SELECT id, order_no, lifecycle_status, activated_at 
FROM orders 
ORDER BY created_at DESC 
LIMIT 5;
```

---

### 问题 2：里程碑状态无法修改

**检查：**
1. 订单生命周期状态是否为"已生效"或"执行中"
2. 浏览器控制台错误信息

**解决：**
- 确保订单已激活
- 检查订单状态：`SELECT lifecycle_status FROM orders WHERE id = '订单ID';`

---

### 问题 3：复盘页面无法访问

**检查：**
1. 订单状态是否为"待复盘"
2. URL 是否正确：`/orders/[订单ID]/retrospective`

**解决：**
- 确保订单已完成或已取消
- 检查 `retrospective_required` 是否为 `true`

---

### 问题 4：Dashboard 不显示待复盘订单

**检查：**
1. 订单 `lifecycle_status` 是否为"待复盘"
2. 检查数据库查询

**解决：**
```sql
-- 检查待复盘订单
SELECT id, order_no, lifecycle_status, terminated_at 
FROM orders 
WHERE lifecycle_status = '待复盘';
```

---

## 📊 数据库验证查询

### 检查订单生命周期状态

```sql
SELECT 
  id,
  order_no,
  lifecycle_status,
  activated_at,
  terminated_at,
  termination_type,
  retrospective_required,
  retrospective_completed_at
FROM orders
ORDER BY created_at DESC
LIMIT 10;
```

### 检查订单日志

```sql
SELECT 
  ol.id,
  ol.order_id,
  ol.action,
  ol.from_status,
  ol.to_status,
  ol.note,
  ol.created_at
FROM order_logs ol
JOIN orders o ON o.id = ol.order_id
WHERE o.order_no = 'QM-20240121-001'  -- 替换为你的订单号
ORDER BY ol.created_at DESC;
```

### 检查取消申请

```sql
SELECT 
  cr.*,
  o.order_no
FROM cancel_requests cr
JOIN orders o ON o.id = cr.order_id
ORDER BY cr.created_at DESC;
```

### 检查复盘记录

```sql
SELECT 
  or_retro.*,
  o.order_no
FROM order_retrospectives or_retro
JOIN orders o ON o.id = or_retro.order_id
ORDER BY or_retro.created_at DESC;
```

---

## ✅ 完整测试检查清单

- [ ] 数据库迁移执行成功
- [ ] 创建订单（草稿状态）
- [ ] 激活订单（已生效→执行中）
- [ ] 推进里程碑（执行中）
- [ ] 申请取消订单（执行中）
- [ ] 批准取消申请（已取消→待复盘）
- [ ] 完成订单（已完成→待复盘）
- [ ] 提交复盘（已复盘）
- [ ] 验证草稿不能改里程碑
- [ ] 验证已取消不能改里程碑
- [ ] 验证未完成里程碑不能结案
- [ ] 验证待复盘订单在Dashboard显示

---

## 🎬 快速测试脚本

如果你想快速验证所有功能，可以按以下顺序操作：

1. **创建订单** → 草稿状态
2. **激活订单** → 执行中状态
3. **完成所有里程碑** → 所有里程碑为"已完成"
4. **结案订单** → 待复盘状态
5. **提交复盘** → 已复盘状态
6. **查看 Dashboard** → 待复盘模块不显示该订单

---

**提示：** 如果遇到问题，查看浏览器控制台（F12）和服务器日志，或参考 `TEST_LIFECYCLE.md` 获取更详细的测试步骤。
