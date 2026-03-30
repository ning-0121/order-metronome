# 引导层实现总结

## 概述

本次实现为"订单节拍器"系统补齐了【引导层】，包含两个核心能力：
1. **4 步向导式 New Order**（强引导）
2. **异常驱动 Dashboard**（每天只处理异常）

## 实现内容

### 【B】4 步向导式 New Order

#### 文件路径
- **修改**：`app/orders/new/page.tsx`（完全重写）

#### Step 管理方式
- 使用 **URL Query 参数**管理 step 状态（`?step=1&order_id=xxx`）
- 刷新页面不丢失当前 step
- 不允许用户直接跳到 Step 3/4（无 order_id 时自动回到 Step 1）

#### Step 1：创建订单（基础信息）
- 表单字段（保持现有）：
  - 订单号（Order No）
  - 客户名称（Customer Name）
  - 贸易条款（Incoterm）
  - ETD / 仓库到货日期（根据 Incoterm 显示）
  - 订单类型（Order Type）
  - 包装类型（Packaging Type）
- CTA：按钮文案为「下一步」
- 行为：
  - 提交后创建 order
  - 成功后自动进入 Step 2
  - 不允许跳过

#### Step 2：自动生成里程碑（系统托底）
- 行为（自动执行）：
  - 基于预设模板，自动生成 milestones（5 条，来自 `MILESTONE_TEMPLATE_V1`）
  - 默认规则：
    - status = '未开始'（除了 `po_confirmed` 为 '进行中'）
    - notes = null
    - owner_role 按模板分配
- UI：
  - 展示生成的 milestones 列表（只读）
  - 文案提示："系统已为你生成完整执行节拍，你只需在执行过程中更新状态"
- CTA：「确认并进入执行」

#### Step 3：执行说明（强引导）
- 纯引导页，不涉及数据修改
- 内容明确：
  - 每个里程碑只有 4 种状态：未开始 / 进行中 / 卡住 / 已完成
  - 卡住 = 必须写原因（notes）
  - 解卡住 = 状态回到进行中
  - 不需要每天维护全部，只处理"异常"
- CTA：「进入订单执行页」

#### Step 4：进入订单详情页
- 自动跳转到 order detail（milestones 执行页）
- 到此向导结束

### 【C】异常驱动 Dashboard

#### 文件路径
- **修改**：`app/dashboard/page.tsx`（完全重写）
- **新增**：`components/UnblockButton.tsx`（解除卡住按钮组件）

#### 模块 1：今日到期（Today Due）

**数据查询逻辑**：
```typescript
const { data: todayDueMilestones } = await supabase
  .from('milestones')
  .select(`
    *,
    orders!inner (
      id,
      order_no,
      customer_name
    )
  `)
  .gte('due_at', `${today}T00:00:00`)
  .lt('due_at', `${tomorrow}T00:00:00`)
  .neq('status', '已完成')
  .order('due_at', { ascending: true });
```

**条件**：
- `due_at` = today（今天 00:00:00 到明天 00:00:00 之间）
- `status != '已完成'`

**UI**：
- 蓝色高亮
- 列表形式
- 显示：订单号、执行步骤名称、负责人角色、截止日期、客户名称
- 点击直接进入对应订单 + milestone 定位

#### 模块 2：已超期（Overdue，优先级最高）

**数据查询逻辑**：
```typescript
const { data: overdueMilestones } = await supabase
  .from('milestones')
  .select(`
    *,
    orders!inner (
      id,
      order_no,
      customer_name
    )
  `)
  .lt('due_at', `${today}T00:00:00`)
  .neq('status', '已完成')
  .order('due_at', { ascending: true });
```

**条件**：
- `due_at < today`（今天 00:00:00 之前）
- `status != '已完成'`

**UI**：
- 红色高亮（优先级最高）
- 排在 Dashboard 第一屏
- 明确文案："这是当前最需要处理的事项"
- 显示同上
- 点击直接进入对应订单 + milestone 定位

#### 模块 3：卡住清单（Blocked）

**数据查询逻辑**：
```typescript
const { data: blockedMilestones } = await supabase
  .from('milestones')
  .select(`
    *,
    orders!inner (
      id,
      order_no,
      customer_name
    )
  `)
  .eq('status', '卡住')
  .order('created_at', { ascending: false });
```

**条件**：
- `status = '卡住'`

**UI**：
- 橙色高亮
- 显示：
  - 订单号
  - 执行步骤名称
  - notes（卡住原因，若无显示"未填写原因"）
  - 当前负责人角色
- 行为：
  - 提供两个按钮：
    - 「解除卡住」→ status='进行中'（使用 `markMilestoneUnblocked`）
    - 「查看订单」

#### 空状态
- 当三个模块都为空时，显示友好的空状态提示

### 新增/修改文件清单

#### 新增文件
1. `components/UnblockButton.tsx` - 解除卡住按钮组件（Client Component）

#### 修改文件
1. `app/orders/new/page.tsx` - 完全重写为 4 步向导
2. `app/dashboard/page.tsx` - 完全重写为异常驱动 Dashboard
3. `app/actions/milestones.ts` - 新增 `markMilestoneUnblocked` 函数

## 交互与文案规范

✅ **不出现英文状态值**：所有状态显示统一为中文  
✅ **所有用户可见文案使用中文**  
✅ **不要求用户理解"milestones"这个词**：显示为"执行步骤"  
✅ **所有"卡住"相关操作明确提示**："卡住不是失败，是为了让系统知道你需要帮助"

## 技术实现细节

### Wizard Step 管理
- 使用 URL Query 参数（`?step=1&order_id=xxx`）
- 使用 `useSearchParams()` 读取（需包裹在 Suspense 中）
- 刷新页面不丢失当前 step
- 不允许直接跳到 Step 3/4（无 order_id 时自动回到 Step 1）

### Dashboard 数据查询
- 使用 Supabase 的 `select` 和 `inner join` 获取关联的 orders 数据
- 使用日期范围查询（`gte`、`lt`）精确匹配今日到期
- 使用 `neq` 排除已完成状态
- 按优先级排序：已超期 > 今日到期 > 卡住清单

### 解除卡住功能
- 使用 `transitionMilestoneStatus` 进行状态转换（卡住 -> 进行中）
- 自动记录事件日志
- 使用 Client Component 处理交互（`UnblockButton`）

## 测试清单

### 向导测试
- [ ] Step 1：填写表单，点击「下一步」，验证订单创建成功
- [ ] Step 2：验证自动生成的里程碑列表显示正确
- [ ] Step 2：点击「确认并进入执行」，验证进入 Step 3
- [ ] Step 3：验证执行说明内容完整
- [ ] Step 3：点击「进入订单执行页」，验证进入 Step 4
- [ ] Step 4：验证自动跳转到订单详情页
- [ ] 刷新页面：验证 step 状态不丢失
- [ ] 直接访问 `/orders/new?step=3`（无 order_id）：验证自动回到 Step 1

### Dashboard 测试
- [ ] 今日到期：验证显示 today due_at 的里程碑
- [ ] 已超期：验证显示 past due_at 的里程碑（红色高亮，第一屏）
- [ ] 卡住清单：验证显示 status='卡住' 的里程碑
- [ ] 解除卡住：点击「解除卡住」按钮，验证状态变为「进行中」
- [ ] 查看订单：点击「查看订单」，验证跳转到订单详情页
- [ ] 空状态：当三个模块都为空时，验证显示友好提示
- [ ] 点击路径：验证所有点击都能一步到位，不迷路

## 构建状态

✅ **TypeScript 编译通过**  
✅ **构建成功**：`npm run build` ✓  
✅ **无类型错误**

## 后续优化建议

1. **向导优化**：
   - 考虑添加"上一步"按钮（Step 2、3）
   - 考虑添加进度保存功能（草稿）

2. **Dashboard 优化**：
   - 考虑添加筛选功能（按负责人角色、订单类型等）
   - 考虑添加批量操作（批量解除卡住）
   - 考虑添加统计信息（总异常数、趋势等）

3. **性能优化**：
   - Dashboard 查询可以考虑添加缓存
   - 考虑使用 Server Components 优化性能
