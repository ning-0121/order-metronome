# 订单生命周期管理测试文档（V1.6）

## 📋 测试目标

验证订单生命周期管理（出生→执行→终结→复盘）全链路功能，确保所有入口封死点正常工作。

---

## ✅ 最小验收步骤

### 1. 创建订单（草稿状态）

**步骤：**
1. 访问 `/orders/new`
2. 填写订单信息并提交
3. 查看订单详情页

**预期结果：**
- ✅ 订单创建成功，`lifecycle_status` 为 `草稿`
- ✅ 订单详情页显示生命周期条，当前状态为"草稿"
- ✅ 显示"✅ 激活订单（进入执行）"按钮
- ✅ 所有里程碑状态为"未开始"（除了第一个可能是"进行中"）

**验证点：**
- 订单号已生成（格式：QM-YYYYMMDD-XXX）
- 订单详情页顶部显示生命周期条

---

### 2. 激活订单（草稿 → 已生效 → 执行中）

**步骤：**
1. 在订单详情页点击"✅ 激活订单（进入执行）"按钮
2. 等待页面刷新

**预期结果：**
- ✅ 订单状态变为"已生效"或"执行中"
- ✅ 生命周期条更新，高亮显示当前状态
- ✅ 第一个里程碑自动变为"进行中"（如果之前都是未开始）
- ✅ 订单日志中记录 `action='activate'`
- ✅ "激活订单"按钮消失

**验证点：**
- 检查 `orders.activated_at` 字段已填充
- 检查 `order_logs` 表中有激活记录

---

### 3. 推进里程碑（执行中状态）

**步骤：**
1. 在订单详情页的执行时间线中
2. 点击某个里程碑的"完成"按钮

**预期结果：**
- ✅ 里程碑状态成功从"进行中"变为"已完成"
- ✅ 下一个里程碑自动推进为"进行中"（如果存在）
- ✅ 里程碑日志中记录状态转换

**验证点：**
- 只有"已生效"或"执行中"状态的订单才能修改里程碑
- 状态转换符合状态机规则

---

### 4. 申请取消订单（执行中状态）

**步骤：**
1. 在订单详情页点击"申请取消订单"按钮
2. 填写取消原因类型和详情
3. 提交申请

**预期结果：**
- ✅ 取消申请创建成功，状态为 `pending`
- ✅ 订单日志中记录 `action='cancel_request'`
- ✅ 订单详情页显示取消申请状态
- ✅ 订单状态仍为"执行中"（未批准前）

**验证点：**
- 检查 `cancel_requests` 表中有新记录
- 只有"执行中"状态的订单才能申请取消

---

### 5. 批准取消申请（执行中 → 已取消 → 待复盘）

**步骤：**
1. 在订单详情页找到取消申请
2. 点击"批准"按钮（需要订单owner权限）
3. 填写审批备注（可选）
4. 提交审批

**预期结果：**
- ✅ 取消申请状态变为 `approved`
- ✅ 订单状态变为"已取消"
- ✅ `orders.terminated_at` 已填充
- ✅ `orders.termination_type` 为"取消"
- ✅ `orders.termination_reason` 已填充
- ✅ 所有未完成的里程碑被冻结（notes追加"订单已取消"）
- ✅ 如果 `retrospective_required=true`，订单自动进入"待复盘"状态
- ✅ 订单日志中记录 `action='cancel_decision'` 和 `action='terminate'`

**验证点：**
- 检查 `cancel_requests.decided_by` 和 `decided_at` 已填充
- 检查订单状态转换符合状态机规则
- 检查未完成里程碑的notes已更新

---

### 6. 完成订单（执行中 → 已完成 → 待复盘）

**前置条件：**
- 订单状态为"执行中"
- 所有里程碑状态为"已完成"

**步骤：**
1. 在订单详情页点击"✅ 结案（完成订单）"按钮
2. 确认操作

**预期结果：**
- ✅ 订单状态变为"已完成"
- ✅ `orders.terminated_at` 已填充
- ✅ `orders.termination_type` 为"完成"
- ✅ 如果 `retrospective_required=true`，订单自动进入"待复盘"状态
- ✅ 订单日志中记录 `action='terminate'`
- ✅ "结案"按钮消失

**验证点：**
- 如果还有未完成的里程碑，"结案"按钮应置灰并提示
- 检查订单状态转换符合状态机规则

---

### 7. 提交复盘（待复盘 → 已复盘）

**步骤：**
1. 访问 `/orders/[id]/retrospective` 或点击"去复盘（必做）"按钮
2. 填写复盘表单：
   - 是否准时交付（必填）
   - 主要延迟原因（如果未准时）
   - 关键问题（必填）
   - 根本原因（必填）
   - 做得好的地方（必填）
   - 改进措施（至少1条，必填）
3. 提交复盘

**预期结果：**
- ✅ 复盘记录创建成功（`order_retrospectives` 表）
- ✅ 订单状态变为"已复盘"
- ✅ `orders.retrospective_completed_at` 已填充
- ✅ 订单日志中记录 `action='retrospective_submit'`
- ✅ Dashboard中待复盘模块不再显示该订单

**验证点：**
- 检查所有必填字段验证正常
- 检查改进措施至少1条
- 检查订单状态转换符合状态机规则

---

### 8. 验证非法操作被拦截

#### 8.1 草稿状态不能修改里程碑

**步骤：**
1. 创建一个新订单（草稿状态）
2. 尝试通过API或UI修改里程碑状态为"进行中"

**预期结果：**
- ✅ 操作被拦截，返回错误："订单状态为'草稿'，无法修改里程碑。只有'已生效'或'执行中'状态的订单才能修改里程碑状态。"

**验证点：**
- `milestonesRepo.transitionMilestoneStatus()` 中的订单状态检查
- `milestonesRepo.updateMilestone()` 中的订单状态检查

---

#### 8.2 已取消/已完成/待复盘/已复盘状态不能修改里程碑

**步骤：**
1. 选择一个已取消/已完成/待复盘/已复盘的订单
2. 尝试修改其里程碑状态

**预期结果：**
- ✅ 操作被拦截，返回错误："订单状态为'[状态]'，无法修改里程碑。只有'已生效'或'执行中'状态的订单才能修改里程碑状态。"

**验证点：**
- Repository层的入口封死点正常工作

---

#### 8.3 草稿不能直接执行中/已完成/已取消

**步骤：**
1. 创建一个新订单（草稿状态）
2. 尝试直接调用 `startExecution()` 或 `completeOrder()` 或 `decideCancel()`

**预期结果：**
- ✅ 操作被拦截，返回错误："订单状态为'草稿'，无法[操作]。只有'[允许状态]'状态的订单才能[操作]。"

**验证点：**
- Domain层的状态转换规则正常工作

---

#### 8.4 已完成/已取消不能直接已复盘

**步骤：**
1. 选择一个已完成或已取消的订单（但未进入待复盘）
2. 尝试直接提交复盘

**预期结果：**
- ✅ 操作被拦截，返回错误："订单状态为'[状态]'，无法提交复盘。只有'待复盘'状态的订单才能提交复盘。"

**验证点：**
- 状态机规则：必须先进入"待复盘"，才能进入"已复盘"

---

#### 8.5 未完成所有里程碑不能结案

**步骤：**
1. 选择一个执行中的订单，但还有未完成的里程碑
2. 尝试点击"结案"按钮

**预期结果：**
- ✅ "结案"按钮置灰，不可点击
- ✅ 提示："仍有未完成执行步骤，无法结案"

**验证点：**
- `completeOrder()` 中的里程碑完成检查

---

## 🔒 入口封死点清单

### Repository层封死点

#### 1. `ordersRepo.activateOrder()`
- ✅ 校验：只有 `lifecycle_status='草稿'` 才能激活
- ✅ 位置：`lib/repositories/ordersRepo.ts:activateOrder()`

#### 2. `ordersRepo.startExecution()`
- ✅ 校验：只有 `lifecycle_status='已生效'` 才能开始执行
- ✅ 位置：`lib/repositories/ordersRepo.ts:startExecution()`

#### 3. `ordersRepo.requestCancel()`
- ✅ 校验：只有 `lifecycle_status='执行中'` 才能申请取消
- ✅ 位置：`lib/repositories/ordersRepo.ts:requestCancel()`

#### 4. `ordersRepo.decideCancel()`
- ✅ 校验：取消申请状态必须为 `pending`
- ✅ 校验：订单状态必须为 `执行中` 才能批准取消
- ✅ 位置：`lib/repositories/ordersRepo.ts:decideCancel()`

#### 5. `ordersRepo.completeOrder()`
- ✅ 校验：只有 `lifecycle_status='执行中'` 才能完成
- ✅ 校验：所有里程碑必须已完成
- ✅ 位置：`lib/repositories/ordersRepo.ts:completeOrder()`

#### 6. `ordersRepo.submitRetrospective()`
- ✅ 校验：只有 `lifecycle_status='待复盘'` 才能提交复盘
- ✅ 位置：`lib/repositories/ordersRepo.ts:submitRetrospective()`

#### 7. `milestonesRepo.transitionMilestoneStatus()`
- ✅ 校验：订单状态必须为 `已生效` 或 `执行中` 才能修改里程碑
- ✅ 校验：状态转换必须符合状态机规则
- ✅ 位置：`lib/repositories/milestonesRepo.ts:transitionMilestoneStatus()`

#### 8. `milestonesRepo.updateMilestone()`
- ✅ 校验：订单状态必须为 `已生效` 或 `执行中` 才能修改里程碑
- ✅ 位置：`lib/repositories/milestonesRepo.ts:updateMilestone()`

### Domain层封死点

#### 1. `transitionOrderLifecycle()`
- ✅ 校验：状态转换必须符合 `ORDER_LIFECYCLE_TRANSITIONS` 规则
- ✅ 位置：`lib/domain/types.ts:transitionOrderLifecycle()`

#### 2. `canModifyMilestones()`
- ✅ 校验：只有 `已生效` 和 `执行中` 状态的订单才允许里程碑变更
- ✅ 位置：`lib/domain/types.ts:canModifyMilestones()`

### UI层封死点

#### 1. 订单详情页
- ✅ 草稿状态：只显示"激活订单"按钮
- ✅ 执行中状态：显示"结案"和"申请取消"按钮
- ✅ 结案按钮：只有所有里程碑完成时才可点击

#### 2. 复盘页面
- ✅ 只有"待复盘"状态的订单才能访问复盘页面
- ✅ 表单验证：必填字段检查
- ✅ 改进措施至少1条

#### 3. Dashboard
- ✅ 待复盘订单模块显示所有 `lifecycle_status='待复盘'` 的订单
- ✅ 点击直接跳转到复盘页面

---

## 🧪 测试环境准备

1. **数据库迁移**
   ```sql
   -- 在 Supabase SQL Editor 中执行
   -- supabase/migrations/20240121000000_add_order_lifecycle.sql
   ```

2. **环境变量**
   - 确保 `.env.local` 已配置 Supabase 连接

3. **启动开发服务器**
   ```bash
   npm run dev
   ```

---

## 📝 测试检查清单

- [ ] 创建订单（草稿）
- [ ] 激活订单（已生效→执行中）
- [ ] 推进里程碑（执行中）
- [ ] 申请取消（执行中）
- [ ] 批准取消（已取消→待复盘）
- [ ] 完成订单（已完成→待复盘）
- [ ] 提交复盘（已复盘）
- [ ] 验证草稿不能改里程碑
- [ ] 验证已取消不能改里程碑
- [ ] 验证未完成里程碑不能结案
- [ ] 验证待复盘订单在Dashboard显示
- [ ] 验证所有状态转换符合状态机规则

---

## 🐛 常见问题

### Q1: 激活订单后状态没有变化？
- 检查数据库迁移是否执行
- 检查 `orders.lifecycle_status` 字段是否存在
- 检查浏览器控制台是否有错误

### Q2: 里程碑状态无法修改？
- 检查订单生命周期状态是否为"已生效"或"执行中"
- 检查状态转换是否符合状态机规则
- 查看浏览器控制台错误信息

### Q3: 复盘页面无法访问？
- 检查订单状态是否为"待复盘"
- 检查URL是否正确：`/orders/[id]/retrospective`

### Q4: Dashboard不显示待复盘订单？
- 检查订单 `lifecycle_status` 是否为"待复盘"
- 检查订单 `retrospective_required` 是否为 `true`
- 检查数据库查询是否正确

---

**最后更新：** 2024-01-21  
**版本：** V1.6
