# 验收测试指南 - Order Metronome T4/T5/T6

本指南将帮助你系统地测试 T4（通知）、T5（里程碑状态机）、T6（延迟请求）三个功能模块。

## 📋 前置准备

### 1. 运行数据库迁移
```sql
-- 在 Supabase SQL Editor 中执行
-- 文件: supabase/migration_t5_t4_t6.sql
```

### 2. 配置环境变量
在 `.env.local` 或 Vercel 环境变量中设置：
```bash
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=your-email@qimoclothing.com
SMTP_PASSWORD=your-password
SMTP_FROM=your-email@qimoclothing.com
CRON_SECRET=your-random-secret-key
```

### 3. 准备测试账号
- 至少一个测试用户账号（`@qimoclothing.com` 邮箱）
- 确保该用户在 `profiles` 表中有记录

---

## 🎯 T5: 里程碑状态机测试

### 测试 5.1: 标记里程碑为 Done
**目标**: 验证 Done 操作能正确更新状态并自动推进下一个里程碑

**步骤**:
1. 登录应用
2. 创建一个新订单（或使用已有订单）
3. 进入订单详情页面
4. 找到状态为 `in_progress` 的里程碑（通常是 `po_confirmed`）
5. 点击 "✅ Done" 按钮
6. 验证：
   - ✅ 该里程碑状态变为 `done`
   - ✅ 下一个里程碑自动变为 `in_progress`
   - ✅ 在 "Activity Log" 中能看到 `mark_done` 和 `auto_advance` 日志

**SQL 验证**:
```sql
-- 查看里程碑状态变化
SELECT 
  step_key, 
  name, 
  status, 
  due_at,
  updated_at
FROM public.milestones
WHERE order_id = 'YOUR_ORDER_ID'
ORDER BY due_at ASC;

-- 查看日志记录
SELECT 
  action, 
  note, 
  created_at
FROM public.milestone_logs
WHERE order_id = 'YOUR_ORDER_ID'
ORDER BY created_at DESC
LIMIT 10;
```

---

### 测试 5.2: 标记里程碑为 Blocked
**目标**: 验证 Blocked 操作需要原因，且会触发邮件通知

**步骤**:
1. 进入订单详情页面
2. 找到状态为 `in_progress` 的里程碑
3. 点击 "❌ Blocked" 按钮
4. 验证表单出现，要求填写原因
5. 尝试不填原因直接提交 → 应该显示错误
6. 填写原因（如："等待客户确认"）
7. 提交
8. 验证：
   - ✅ 里程碑状态变为 `blocked`
   - ✅ `blocked_reason` 字段被保存
   - ✅ 订单列表中的订单状态显示为 RED
   - ✅ 在 "Activity Log" 中能看到 `mark_blocked` 日志
   - ✅ 收到阻塞通知邮件（检查收件箱）

**SQL 验证**:
```sql
-- 查看阻塞的里程碑
SELECT 
  step_key, 
  name, 
  status, 
  blocked_reason
FROM public.milestones
WHERE status = 'blocked';

-- 查看阻塞通知
SELECT 
  kind, 
  sent_to, 
  sent_at,
  payload
FROM public.notifications
WHERE kind = 'blocked'
ORDER BY sent_at DESC;
```

---

### 测试 5.3: 订单状态计算（GREEN/YELLOW/RED）
**目标**: 验证订单状态能正确反映里程碑状态

**测试场景**:

**场景 A: GREEN 状态**
- 所有里程碑都正常，没有阻塞，没有逾期
- 验证：订单列表显示绿色状态标签

**场景 B: YELLOW 状态**
- 创建一个里程碑，将 `due_at` 设置为未来 30 小时内
- 状态设为 `in_progress`
- 验证：订单列表显示黄色状态标签

**场景 C: RED 状态**
- 场景 C1: 有阻塞的里程碑 → 应该显示 RED
- 场景 C2: 有逾期的 `in_progress` 里程碑（`due_at` < now）→ 应该显示 RED

**SQL 验证**:
```sql
-- 查看所有订单及其里程碑状态
SELECT 
  o.order_no,
  o.customer_name,
  COUNT(m.id) as total_milestones,
  COUNT(CASE WHEN m.status = 'blocked' THEN 1 END) as blocked_count,
  COUNT(CASE WHEN m.status = 'in_progress' AND m.due_at < NOW() THEN 1 END) as overdue_count
FROM public.orders o
LEFT JOIN public.milestones m ON m.order_id = o.id
GROUP BY o.id, o.order_no, o.customer_name;
```

---

## 🔔 T4: 通知系统测试

### 测试 4.1: 48/24/12 小时提醒
**目标**: 验证定时任务能正确发送提醒邮件

**准备工作**:
创建一个测试里程碑，将 `due_at` 设置为未来合适的时间。

**方法 1: 手动触发 Cron Job**
1. 在浏览器中访问（或使用 curl）:
```
GET https://your-domain.com/api/cron/reminders
Authorization: Bearer YOUR_CRON_SECRET
```
2. 验证：
   - ✅ 返回 200 状态码
   - ✅ 返回 JSON 包含发送的提醒列表

**方法 2: 等待自动触发**
- Vercel Cron 每 15 分钟运行一次
- 检查 Vercel 日志查看执行情况

**测试步骤**:
1. 创建一个里程碑，`due_at` 设置为未来 25 小时（触发 24 小时提醒）
2. 将状态设为 `in_progress`
3. 手动调用 cron endpoint（或等待下次自动运行）
4. 验证：
   - ✅ `notifications` 表中创建了 `remind_24` 记录
   - ✅ 收到邮件提醒
   - ✅ 再次调用不会重复发送（唯一约束生效）

**SQL 验证**:
```sql
-- 查看所有通知记录
SELECT 
  kind,
  sent_to,
  sent_at,
  payload->>'order_no' as order_no,
  payload->>'milestone_name' as milestone_name
FROM public.notifications
ORDER BY sent_at DESC
LIMIT 20;

-- 检查是否有重复发送（不应该有）
SELECT 
  milestone_id,
  kind,
  sent_to,
  COUNT(*) as count
FROM public.notifications
GROUP BY milestone_id, kind, sent_to
HAVING COUNT(*) > 1;
```

---

### 测试 4.2: 逾期通知
**目标**: 验证逾期里程碑能触发通知

**步骤**:
1. 创建一个里程碑，`due_at` 设置为过去的时间（如：昨天）
2. 状态设为 `in_progress`
3. 调用 cron endpoint
4. 验证：
   - ✅ `notifications` 表中创建了 `overdue` 记录
   - ✅ 收到逾期邮件（标记为 URGENT）

---

### 测试 4.3: 阻塞即时通知
**目标**: 验证阻塞里程碑时立即发送邮件

**步骤**:
1. 执行测试 5.2（标记里程碑为 Blocked）
2. 验证：
   - ✅ 立即创建 `blocked` 通知记录
   - ✅ 立即发送邮件（不需要等待 cron）
   - ✅ 邮件包含阻塞原因

---

## ⏱️ T6: 延迟请求测试

### 测试 6.1: 创建延迟请求（修改锚点日期）
**目标**: 验证延迟请求创建流程

**步骤**:
1. 进入订单详情页面
2. 找到任意一个里程碑
3. 展开里程碑详情
4. 在 "Request Delay" 表单中：
   - 选择 "Change Anchor Date"
   - 填写原因类型（如：`supplier_delay`）
   - 填写原因详情
   - 设置新的锚点日期（比原来晚 7 天）
5. 提交
6. 验证：
   - ✅ 延迟请求创建成功（状态为 `pending`）
   - ✅ 在订单详情页面看到延迟请求列表
   - ✅ 收到延迟请求邮件通知
   - ✅ `milestone_logs` 中有 `request_delay` 记录

**SQL 验证**:
```sql
-- 查看延迟请求
SELECT 
  dr.*,
  o.order_no,
  m.name as milestone_name
FROM public.delay_requests dr
JOIN public.orders o ON o.id = dr.order_id
JOIN public.milestones m ON m.id = dr.milestone_id
WHERE dr.status = 'pending'
ORDER BY dr.created_at DESC;
```

---

### 测试 6.2: 审批延迟请求（锚点日期修改）
**目标**: 验证审批后自动重新计算所有里程碑

**步骤**:
1. 找到测试 6.1 创建的延迟请求
2. 记录当前所有里程碑的 `due_at` 日期
3. 点击 "Review" 按钮
4. 填写决策备注（可选）
5. 点击 "Approve"
6. 验证：
   - ✅ 延迟请求状态变为 `approved`
   - ✅ 订单的 `etd` 或 `warehouse_due_date` 已更新
   - ✅ **所有里程碑的 `due_at` 和 `planned_at` 已重新计算**
   - ✅ 收到审批确认邮件
   - ✅ `milestone_logs` 中有 `approve_delay` 和 `recalc_schedule` 记录

**SQL 验证**:
```sql
-- 查看审批后的订单日期
SELECT 
  order_no,
  incoterm,
  etd,
  warehouse_due_date
FROM public.orders
WHERE id = 'YOUR_ORDER_ID';

-- 查看重新计算后的里程碑日期
SELECT 
  step_key,
  name,
  due_at,
  planned_at,
  updated_at
FROM public.milestones
WHERE order_id = 'YOUR_ORDER_ID'
ORDER BY due_at ASC;

-- 查看相关日志
SELECT 
  action,
  note,
  payload,
  created_at
FROM public.milestone_logs
WHERE order_id = 'YOUR_ORDER_ID'
  AND action IN ('approve_delay', 'recalc_schedule')
ORDER BY created_at DESC;
```

---

### 测试 6.3: 创建延迟请求（仅修改单个里程碑）
**目标**: 验证只修改单个里程碑日期的场景

**步骤**:
1. 创建延迟请求时选择 "Change This Milestone Due Date Only"
2. 设置新的 `due_at`（比原来晚 3 天）
3. 审批该请求
4. 验证：
   - ✅ 该里程碑的 `due_at` 已更新
   - ✅ **所有下游里程碑（due_at >= 原里程碑日期）按相同增量（3天）调整**
   - ✅ 上游里程碑不受影响

**SQL 验证**:
```sql
-- 对比修改前后的日期变化
-- （需要在修改前后分别执行）

-- 修改前记录（手动保存）
SELECT step_key, due_at FROM public.milestones WHERE order_id = 'YOUR_ORDER_ID' ORDER BY due_at;

-- 修改后查看
SELECT step_key, due_at FROM public.milestones WHERE order_id = 'YOUR_ORDER_ID' ORDER BY due_at;
```

---

### 测试 6.4: 拒绝延迟请求
**目标**: 验证拒绝流程

**步骤**:
1. 创建一个延迟请求
2. 点击 "Review" → "Reject"
3. **必须填写拒绝原因**（否则应该提示错误）
4. 填写原因并提交
5. 验证：
   - ✅ 延迟请求状态变为 `rejected`
   - ✅ 里程碑日期**未改变**
   - ✅ `milestone_logs` 中有 `reject_delay` 记录

---

## 🧪 综合测试场景

### 场景 1: 完整订单流程
1. 创建订单 → 验证 5 个里程碑自动生成
2. 标记第一个里程碑为 Done → 验证自动推进
3. 继续推进到第三个里程碑
4. 阻塞第三个里程碑 → 验证状态变 RED，收到邮件
5. 创建延迟请求（锚点日期）→ 验证请求创建
6. 审批延迟请求 → 验证所有里程碑重新计算
7. 解除阻塞，继续推进 → 验证状态恢复

### 场景 2: 通知集成测试
1. 创建订单，里程碑 `due_at` 设置为未来 25 小时
2. 手动触发 cron → 验证 24 小时提醒
3. 修改 `due_at` 为未来 13 小时，再次触发 → 验证 12 小时提醒
4. 修改 `due_at` 为过去，触发 → 验证逾期提醒
5. 阻塞里程碑 → 验证阻塞即时通知

---

## ✅ 验收清单

### T5 验收项
- [ ] 可以标记里程碑为 Done
- [ ] Done 后自动推进下一个里程碑
- [ ] 可以标记里程碑为 Blocked（必须填写原因）
- [ ] Blocked 后订单状态变为 RED
- [ ] 所有操作都记录在 `milestone_logs` 中
- [ ] 订单状态计算正确（GREEN/YELLOW/RED）

### T4 验收项
- [ ] 48/24/12 小时提醒正常工作
- [ ] 逾期通知正常工作
- [ ] 阻塞即时通知正常工作
- [ ] 通知不会重复发送（唯一约束生效）
- [ ] Cron job 可以正常触发
- [ ] 邮件发送成功（检查收件箱）

### T6 验收项
- [ ] 可以创建延迟请求（锚点日期）
- [ ] 可以创建延迟请求（单个里程碑）
- [ ] 审批延迟请求后，锚点日期修改 → 所有里程碑重新计算
- [ ] 审批延迟请求后，单个里程碑修改 → 下游里程碑按增量调整
- [ ] 可以拒绝延迟请求（必须填写原因）
- [ ] 拒绝后里程碑日期不变
- [ ] 延迟请求和审批都记录在日志中
- [ ] 延迟请求创建和审批都会发送邮件通知

---

## 🐛 常见问题排查

### 邮件未发送
1. 检查环境变量是否正确设置
2. 检查 SMTP 配置是否正确
3. 查看应用日志是否有错误
4. 验证 `notifications` 表中是否有记录（即使邮件失败也应该有记录）

### Cron Job 未运行
1. 检查 `vercel.json` 配置
2. 检查 Vercel 项目设置中的 Cron 配置
3. 手动访问 cron endpoint 验证是否工作
4. 查看 Vercel 函数日志

### 调度重新计算不正确
1. 检查 `lib/schedule.ts` 中的 `calcDueDates` 函数
2. 验证日期格式是否正确
3. 查看 `milestone_logs` 中的 `recalc_schedule` 记录
4. 检查时区设置

### RLS 权限问题
1. 确认用户已登录
2. 确认 `is_order_owner` 函数正常工作
3. 检查 RLS 策略是否正确应用

---

## 📊 SQL 查询工具

### 查看订单完整状态
```sql
SELECT 
  o.order_no,
  o.customer_name,
  o.incoterm,
  COUNT(DISTINCT m.id) as milestone_count,
  COUNT(DISTINCT CASE WHEN m.status = 'blocked' THEN m.id END) as blocked,
  COUNT(DISTINCT CASE WHEN m.status = 'done' THEN m.id END) as done,
  COUNT(DISTINCT CASE WHEN m.status = 'in_progress' THEN m.id END) as in_progress,
  COUNT(DISTINCT dr.id) as delay_requests
FROM public.orders o
LEFT JOIN public.milestones m ON m.order_id = o.id
LEFT JOIN public.delay_requests dr ON dr.order_id = o.id
GROUP BY o.id, o.order_no, o.customer_name, o.incoterm
ORDER BY o.created_at DESC;
```

### 查看最近的活动日志
```sql
SELECT 
  ml.action,
  ml.note,
  ml.created_at,
  o.order_no,
  m.name as milestone_name
FROM public.milestone_logs ml
JOIN public.orders o ON o.id = ml.order_id
LEFT JOIN public.milestones m ON m.id = ml.milestone_id
ORDER BY ml.created_at DESC
LIMIT 50;
```

---

## 🎉 完成验收后

如果所有测试通过，恭喜！T4/T5/T6 功能已成功实现。

下一步可以考虑：
1. 监控生产环境的日志和错误
2. 收集用户反馈，优化 UI/UX
3. 根据实际使用情况调整提醒时间（48/24/12 小时）
4. 考虑添加更多通知渠道（如企业微信、钉钉等）
