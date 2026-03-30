# 🧪 引导层功能测试指南

## 快速开始

### 1. 启动开发服务器

```bash
cd /Users/ning/order-metronome
npm run dev
```

看到以下输出表示启动成功：
```
  ▲ Next.js 16.1.1
  - Local:        http://localhost:3000
```

### 2. 打开浏览器

访问：**http://localhost:3000**

---

## 📋 测试场景

### 【测试场景 1】4 步向导式 New Order

#### 测试步骤

**Step 1: 创建订单**

1. 访问 `/orders/new` 或点击导航栏的"新建订单"
2. **验证**：
   - ✅ 看到进度指示器（4 个步骤，当前在 Step 1）
   - ✅ 看到"步骤 1：创建订单（基础信息）"标题
   - ✅ 看到所有必填字段：订单号、客户名称、贸易条款、ETD/仓库到货日期、订单类型、包装类型

3. 填写表单：
   - 订单号：`TEST-2024-001`
   - 客户名称：`测试客户`
   - 贸易条款：选择 `FOB`
   - ETD：选择未来某个日期（例如：7 天后）
   - 订单类型：`批量订单`
   - 包装类型：`标准包装`

4. 点击「下一步」按钮
5. **验证**：
   - ✅ 页面显示"创建中..."
   - ✅ 成功后自动进入 Step 2
   - ✅ URL 变为 `/orders/new?step=2&order_id=xxx`

**Step 2: 自动生成里程碑**

1. **验证**：
   - ✅ 看到"步骤 2：系统已生成执行步骤"标题
   - ✅ 看到蓝色提示框："系统已为你生成完整执行节拍..."
   - ✅ 看到生成的里程碑列表（应该显示 5 个执行步骤）
   - ✅ 每个里程碑显示：序号、名称、负责人角色、截止日期、状态

2. 检查里程碑内容：
   - ✅ 第一个里程碑（PO确认）状态为"进行中"
   - ✅ 其他里程碑状态为"未开始"
   - ✅ 所有里程碑的 notes 为 null

3. 点击「确认并进入执行」按钮
4. **验证**：
   - ✅ 自动进入 Step 3
   - ✅ URL 变为 `/orders/new?step=3&order_id=xxx`

**Step 3: 执行说明**

1. **验证**：
   - ✅ 看到"步骤 3：执行说明"标题
   - ✅ 看到三个说明区块：
     - 执行步骤的 4 种状态（未开始/进行中/卡住/已完成）
     - 关于"卡住"状态的说明（强调"卡住不是失败"）
     - 日常使用建议（只处理异常）

2. 阅读说明内容，确认文案清晰易懂

3. 点击「进入订单执行页」按钮
4. **验证**：
   - ✅ 自动进入 Step 4
   - ✅ URL 变为 `/orders/new?step=4&order_id=xxx`

**Step 4: 跳转**

1. **验证**：
   - ✅ 看到"向导完成！"提示
   - ✅ 看到 ✅ 图标
   - ✅ 看到"正在跳转到订单执行页面..."

2. 等待 1-2 秒
3. **验证**：
   - ✅ 自动跳转到 `/orders/[order_id]` 订单详情页
   - ✅ 如果未自动跳转，点击"如果未自动跳转，请点击这里"链接也能跳转

#### 额外测试：刷新页面不丢失状态

1. 在 Step 2 时，刷新页面（F5 或 Cmd+R）
2. **验证**：
   - ✅ 页面刷新后仍停留在 Step 2
   - ✅ 里程碑列表仍然显示
   - ✅ URL 中的 `step=2&order_id=xxx` 保持不变

#### 额外测试：不允许直接跳到 Step 3/4

1. 直接访问 `/orders/new?step=3`（无 order_id）
2. **验证**：
   - ✅ 自动回到 Step 1（或显示错误提示）

---

### 【测试场景 2】异常驱动 Dashboard

#### 前置准备：创建测试数据

为了测试 Dashboard 的三个模块，需要先创建一些测试数据：

**方法 1：通过 UI 创建（推荐）**
1. 使用向导创建几个订单
2. 在订单详情页手动修改一些里程碑的状态和日期

**方法 2：通过 Supabase SQL Editor 直接插入（快速）**

```sql
-- 假设你已经有一个订单 ID，替换为实际的 order_id
-- 获取一个订单 ID
SELECT id, order_no FROM orders LIMIT 1;

-- 创建"今日到期"的里程碑（替换 order_id）
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, is_critical, evidence_required)
VALUES 
  ('你的订单ID', 'test_today', '测试-今日到期', 'sales', CURRENT_DATE, '进行中', true, false);

-- 创建"已超期"的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, is_critical, evidence_required)
VALUES 
  ('你的订单ID', 'test_overdue', '测试-已超期', 'finance', CURRENT_DATE - INTERVAL '1 day', '进行中', true, false);

-- 创建"卡住"的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, notes, is_critical, evidence_required)
VALUES 
  ('你的订单ID', 'test_blocked', '测试-卡住', 'production', CURRENT_DATE + INTERVAL '3 days', '卡住', '卡住原因：测试卡住原因', true, false);
```

#### 测试步骤

**访问 Dashboard**

1. 登录后访问 `/dashboard` 或点击导航栏的"Dashboard"
2. **验证**：
   - ✅ 看到"异常驱动 Dashboard"标题
   - ✅ 看到欢迎信息（显示用户名或邮箱）
   - ✅ 看到说明文字："这里只显示需要你关注的事项：今日到期、已超期、卡住清单"

**模块 1：今日到期**

1. **验证**：
   - ✅ 如果有今日到期的里程碑，看到"📅 今日到期（数量）"模块
   - ✅ 模块为蓝色高亮（`bg-blue-50`）
   - ✅ 每个条目显示：
     - 订单号（可点击）
     - "今日到期"标签
     - 执行步骤名称
     - 负责人角色
     - 截止日期
     - 客户名称（如果有）
   - ✅ 每个条目有"查看订单"按钮

2. 点击订单号或"查看订单"按钮
3. **验证**：
   - ✅ 跳转到订单详情页
   - ✅ URL 包含 `#milestone-xxx` 锚点（如果支持）

**模块 2：已超期（优先级最高）**

1. **验证**：
   - ✅ 如果有已超期的里程碑，看到"⚠️ 已超期（数量）"模块
   - ✅ 模块为红色高亮（`bg-red-50`，`border-red-300`）
   - ✅ **排在 Dashboard 第一屏**（在"今日到期"之前）
   - ✅ 看到明确文案："这是当前最需要处理的事项"
   - ✅ 每个条目显示内容同上
   - ✅ 每个条目有"查看订单"按钮

2. 点击订单号或"查看订单"按钮
3. **验证**：
   - ✅ 跳转到订单详情页

**模块 3：卡住清单**

1. **验证**：
   - ✅ 如果有卡住的里程碑，看到"🚫 卡住清单（数量）"模块
   - ✅ 模块为橙色高亮（`bg-orange-50`）
   - ✅ 每个条目显示：
     - 订单号（可点击）
     - "卡住"标签
     - 执行步骤名称
     - 负责人角色
     - 客户名称（如果有）
     - **卡住原因**（从 notes 提取，显示在橙色框内）
   - ✅ 每个条目有两个按钮：
     - 「解除卡住」（绿色）
     - 「查看订单」（橙色）

2. **测试"解除卡住"功能**：
   - 点击「解除卡住」按钮
   - **验证**：
     - ✅ 按钮显示"处理中..."（loading 状态）
     - ✅ 成功后，该条目从"卡住清单"中消失
     - ✅ 页面自动刷新（`router.refresh()`）
     - ✅ 该里程碑状态变为"进行中"（可在订单详情页验证）

3. **测试"查看订单"功能**：
   - 点击「查看订单」按钮
   - **验证**：
     - ✅ 跳转到订单详情页

**空状态测试**

1. 如果三个模块都为空（没有异常事项）
2. **验证**：
   - ✅ 看到友好的空状态提示
   - ✅ 显示 🎉 图标
   - ✅ 显示"暂无异常事项"文字
   - ✅ 显示"所有执行步骤都在正常进行中，继续保持！"
   - ✅ 显示"查看所有订单"按钮

---

## 🔍 详细验证清单

### 向导功能验证

- [ ] Step 1 表单验证（必填字段）
- [ ] Step 1 提交后创建订单成功
- [ ] Step 2 自动生成里程碑列表
- [ ] Step 2 里程碑信息完整（名称、负责人、日期、状态）
- [ ] Step 3 执行说明内容完整
- [ ] Step 4 自动跳转到订单详情页
- [ ] 刷新页面不丢失 step 状态
- [ ] URL query 参数正确（step、order_id）
- [ ] 不允许直接跳到 Step 3/4（无 order_id）

### Dashboard 功能验证

- [ ] 今日到期模块显示正确
- [ ] 已超期模块显示正确（红色高亮，第一屏）
- [ ] 卡住清单模块显示正确
- [ ] 卡住原因正确提取和显示
- [ ] "解除卡住"功能正常
- [ ] "查看订单"跳转正常
- [ ] 空状态显示友好
- [ ] 所有点击路径一步到位

### 交互与文案验证

- [ ] 所有状态值显示为中文（无英文）
- [ ] 所有用户可见文案为中文
- [ ] "milestones" 显示为"执行步骤"
- [ ] 卡住相关提示明确："卡住不是失败..."

---

## 🐛 常见问题排查

### 问题 1：向导 Step 2 看不到里程碑

**可能原因**：
- 订单创建失败
- 里程碑生成失败

**排查步骤**：
1. 检查浏览器控制台（F12）是否有错误
2. 检查 `app/actions/orders.ts` 中的 `createOrder` 函数
3. 检查 Supabase 数据库中是否有对应的 milestones

### 问题 2：Dashboard 显示为空

**可能原因**：
- 没有符合条件的里程碑数据
- 查询条件不正确

**排查步骤**：
1. 检查 Supabase 数据库中是否有里程碑数据
2. 检查里程碑的 `due_at` 和 `status` 字段
3. 检查 Dashboard 查询逻辑（`app/dashboard/page.tsx`）

### 问题 3："解除卡住"按钮不工作

**可能原因**：
- `markMilestoneUnblocked` 函数错误
- 状态转换校验失败

**排查步骤**：
1. 检查浏览器控制台是否有错误
2. 检查 `app/actions/milestones.ts` 中的 `markMilestoneUnblocked` 函数
3. 检查状态机转换规则（`lib/domain/types.ts`）

---

## 📊 测试数据准备 SQL

如果需要快速创建测试数据，可以在 Supabase SQL Editor 中执行：

```sql
-- 1. 获取一个订单 ID（假设已存在）
-- 替换为实际的 order_id
SET @order_id = (SELECT id FROM orders LIMIT 1);

-- 2. 创建今日到期的里程碑
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

-- 3. 创建已超期的里程碑
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

-- 4. 创建卡住的里程碑
INSERT INTO milestones (order_id, step_key, name, owner_role, due_at, status, notes, is_critical, evidence_required)
SELECT 
  id,
  'test_blocked_' || id::text,
  '测试-卡住',
  'production',
  CURRENT_DATE + INTERVAL '3 days',
  '卡住',
  '卡住原因：这是一个测试卡住原因，用于验证 Dashboard 显示',
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
3. ✅ 所有交互功能正常（点击、跳转、状态更新）
4. ✅ 文案规范（中文、无英文状态值）
5. ✅ 异常情况处理（空状态、刷新页面）

---

## 🚀 下一步

测试通过后，可以：
1. 部署到生产环境
2. 收集用户反馈
3. 根据反馈优化交互和文案
