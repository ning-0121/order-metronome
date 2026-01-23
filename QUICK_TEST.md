# 🚀 快速测试指南

## ✅ 开发服务器已启动

服务器正在启动中，请稍候...

## 📍 访问地址

- **本地地址**：http://localhost:3000
- **测试向导**：http://localhost:3000/orders/new
- **测试 Dashboard**：http://localhost:3000/dashboard

---

## 🧪 快速测试流程

### 1️⃣ 测试 4 步向导式 New Order

#### 步骤 1：创建订单
1. 访问：http://localhost:3000/orders/new
2. 填写表单：
   - **订单号**：`TEST-2024-001`
   - **客户名称**：`测试客户`
   - **贸易条款**：选择 `FOB`
   - **ETD**：选择未来某个日期（例如：7天后）
   - **订单类型**：`批量订单`
   - **包装类型**：`标准包装`
3. 点击 **「下一步」** 按钮

#### 步骤 2：查看生成的执行步骤
- ✅ 验证：看到自动生成的 5 个执行步骤
- ✅ 验证：第一个（PO确认）状态为"进行中"
- ✅ 验证：其他状态为"未开始"
- 点击 **「确认并进入执行」** 按钮

#### 步骤 3：阅读执行说明
- ✅ 验证：看到三个说明区块
- ✅ 验证：文案清晰易懂
- 点击 **「进入订单执行页」** 按钮

#### 步骤 4：自动跳转
- ✅ 验证：看到"向导完成！"提示
- ✅ 验证：自动跳转到订单详情页

#### 额外测试：刷新页面
- 在 Step 2 时，按 `F5` 或 `Cmd+R` 刷新
- ✅ 验证：页面停留在 Step 2，不丢失状态

---

### 2️⃣ 测试异常驱动 Dashboard

#### 访问 Dashboard
1. 访问：http://localhost:3000/dashboard
2. 登录（如果未登录）

#### 查看三个模块

**模块 1：已超期（优先级最高）**
- ✅ 验证：如果有已超期里程碑，显示红色高亮模块
- ✅ 验证：排在 Dashboard 第一屏
- ✅ 验证：明确文案"这是当前最需要处理的事项"
- ✅ 验证：每个条目显示：订单号、执行步骤、负责人、截止日期

**模块 2：今日到期**
- ✅ 验证：如果有今日到期里程碑，显示蓝色高亮模块
- ✅ 验证：每个条目显示完整信息

**模块 3：卡住清单**
- ✅ 验证：如果有卡住里程碑，显示橙色高亮模块
- ✅ 验证：显示卡住原因（从 notes 提取）
- ✅ 验证：有两个按钮："解除卡住" 和 "查看订单"

#### 测试解除卡住功能
1. 如果有卡住的里程碑，点击 **「解除卡住」** 按钮
2. ✅ 验证：按钮显示"处理中..."
3. ✅ 验证：成功后，该条目从列表中消失
4. ✅ 验证：页面自动刷新

#### 测试查看订单功能
1. 点击任意订单号或 **「查看订单」** 按钮
2. ✅ 验证：跳转到订单详情页

#### 空状态测试
- 如果没有异常事项，✅ 验证：显示友好的空状态提示

---

## 🔍 检查清单

### 向导功能
- [ ] Step 1 表单验证正常
- [ ] Step 2 自动生成里程碑列表
- [ ] Step 3 执行说明内容完整
- [ ] Step 4 自动跳转正常
- [ ] 刷新页面不丢失状态

### Dashboard 功能
- [ ] 已超期模块显示正确（红色，第一屏）
- [ ] 今日到期模块显示正确（蓝色）
- [ ] 卡住清单模块显示正确（橙色）
- [ ] 解除卡住功能正常
- [ ] 查看订单跳转正常

### 交互与文案
- [ ] 所有状态值显示为中文
- [ ] 所有文案为中文
- [ ] "milestones" 显示为"执行步骤"
- [ ] 卡住提示："卡住不是失败..."

---

## 🐛 如果遇到问题

### 服务器未启动
```bash
cd /Users/ning/order-metronome
npm run dev
```

### 端口被占用
```bash
PORT=3001 npm run dev
# 然后访问 http://localhost:3001
```

### 查看服务器日志
检查终端输出，查看是否有错误信息

### 检查浏览器控制台
按 `F12` 打开开发者工具，查看 Console 是否有错误

---

## 📝 测试数据准备（可选）

如果需要快速创建测试数据，可以在 Supabase SQL Editor 中执行：

```sql
-- 获取一个订单 ID（假设已存在）
-- 然后创建测试里程碑

-- 今日到期的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, is_critical, evidence_required)
SELECT 
  id,
  'test_today_' || id::text,
  '测试-今日到期',
  'sales',
  CURRENT_DATE,
  '进行中',
  true,
  false
FROM orders
LIMIT 1;

-- 已超期的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, is_critical, evidence_required)
SELECT 
  id,
  'test_overdue_' || id::text,
  '测试-已超期',
  'finance',
  CURRENT_DATE - INTERVAL '1 day',
  '进行中',
  true,
  false
FROM orders
LIMIT 1;

-- 卡住的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, notes, is_critical, evidence_required)
SELECT 
  id,
  'test_blocked_' || id::text,
  '测试-卡住',
  'production',
  CURRENT_DATE + INTERVAL '3 days',
  '卡住',
  '卡住原因：这是一个测试卡住原因',
  true,
  false
FROM orders
LIMIT 1;
```

---

## ✅ 测试完成标准

完成以下所有验证后，表示测试通过：

1. ✅ 向导流程完整（Step 1-4）
2. ✅ Dashboard 三个模块正常显示
3. ✅ 所有交互功能正常
4. ✅ 文案规范（中文、无英文状态值）
5. ✅ 异常情况处理正常

---

祝测试顺利！🎉
