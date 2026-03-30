# 订单号生成与入口控制实现总结

## 🎯 实现目标

✅ **全部达成**：
1. ✅ 订单号（order_no）只能由系统生成
2. ✅ 任何订单在系统中存在之前，必须先获得 order_no
3. ✅ 订单号一旦生成，永不回收、不修改
4. ✅ 订单号生成必须是事务安全的（防并发重复）
5. ✅ 不破坏现有 orders / milestones / onboarding 结构
6. ✅ 不引入多余抽象，不提前做多租户

---

## 📋 实现内容

### Step 1：新增订单号序列表（数据库）

**文件**：`supabase/migrations/20240115000000_add_order_sequences.sql`

**表结构**：
```sql
CREATE TABLE public.order_sequences (
  date_key date PRIMARY KEY,
  current_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**特性**：
- 每天一行，用于控制「当日第几单」
- 不允许删除（无 DELETE policy）
- 不允许回滚（关键表）
- 索引：`idx_order_sequences_date_key`

**PostgreSQL 函数**：
```sql
CREATE FUNCTION public.generate_order_sequence(_date_key date)
RETURNS integer
```
- 原子操作：使用 `ON CONFLICT DO UPDATE` 确保并发安全
- 事务安全：在数据库层面保证原子性
- 自动处理：新记录返回 1，已有记录递增

### Step 2：在 Repository 层实现"安全生成订单号"

**文件**：`lib/repositories/ordersRepo.ts`

**函数**：`generateOrderNo(): Promise<{ orderNo?: string; error?: string }>`

**实现方式**：
- 调用 PostgreSQL 函数 `generate_order_sequence(date)` 确保原子性
- 订单号格式：`QM-YYYYMMDD-XXX`
  - 示例：`QM-20260121-001`, `QM-20260121-012`
- 使用 `supabase.rpc()` 调用数据库函数

**约束**：
- ✅ 在数据库事务中执行（PostgreSQL 函数）
- ✅ 对 order_sequences 当天行加锁（ON CONFLICT 确保）
- ✅ 若当天无记录 → insert (current_seq = 1)
- ✅ 若已有记录 → current_seq + 1
- ✅ 订单号一旦生成，永不回收、不修改

**禁止**：
- ❌ 使用 JS 时间做唯一性
- ❌ 使用 UUID
- ❌ 使用 orders 表 count
- ❌ 使用前端生成

### Step 3：调整 ordersRepo.createOrder()

**修改内容**：

1. **白名单调整**：
   - `order_no` 从 `INSERT_WHITELIST` 中移除
   - 禁止外部传入 `order_no`

2. **sanitizePayload 函数**：
   - 检测 `order_no` 字段，直接丢弃，不报错
   - Dev 环境警告：`order_no is system-generated`

3. **createOrder 函数**：
   - 新增参数：`orderNo?: string`（可选，用于预生成的订单号）
   - 如果未提供 `orderNo`，自动调用 `generateOrderNo()`
   - 如果提供 `orderNo`，直接使用（来自向导预生成）
   - `order_no` 必须在 orders 表中写入

4. **UPDATE_BLACKLIST**：
   - 添加 `order_no`，禁止更新订单号

### Step 4：改造 New Order 向导（入口控制）

**文件**：`app/orders/new/page.tsx`

**行为改造**：

1. **页面加载时（Step 1）**：
   - 调用 `preGenerateOrderNo()` Server Action
   - 系统预生成一个订单号
   - 页面顶部展示：
     ```
     订单号：QM-20260121-003（系统已保留）
     ```

2. **表单提交**：
   - 使用预生成的订单号创建订单
   - 传入 `createOrder(formData, preGeneratedOrderNo)`

3. **订单号输入框**：
   - ✅ 已移除（订单号由系统生成）

4. **用户行为处理**：
   - 刷新页面：订单号不回收（已生成）
   - 中途关闭：订单号不回收（已生成）
   - 放弃创建：订单号不回收（已生成）

**新增 Server Action**：
- `app/actions/orders.ts`：`preGenerateOrderNo()`
  - 调用 `generateOrderNo()` 生成订单号
  - 返回订单号供前端使用

### Step 5：系统铁律（代码层约束）

**已落实的约束**：

1. **禁止直接 insert orders 不带 order_no**：
   - ✅ `createOrder()` 函数必须生成或使用预生成的订单号
   - ✅ 白名单已移除 `order_no`，外部无法传入

2. **禁止 update order_no**：
   - ✅ `UPDATE_BLACKLIST` 包含 `order_no`
   - ✅ `updateOrder()` 函数检测并移除 `order_no`

3. **删除订单 ≠ 删除记录**：
   - ⚠️ 当前实现：物理删除（`deleteOrder()`）
   - 💡 建议：未来改为逻辑删除（添加 `deleted_at` 字段）

**关键位置注释**：
- ✅ `lib/repositories/ordersRepo.ts`：所有关键函数都有 `⚠️ 系统级约束` 注释
- ✅ `app/actions/orders.ts`：`createOrder` 和 `preGenerateOrderNo` 都有约束说明
- ✅ `app/orders/new/page.tsx`：订单号显示区域有约束说明

---

## 🔒 并发安全实现

### PostgreSQL 函数实现

```sql
CREATE FUNCTION public.generate_order_sequence(_date_key date)
RETURNS integer
```

**并发安全机制**：
1. 使用 `INSERT ... ON CONFLICT DO UPDATE` 确保原子性
2. 数据库层面的事务保证
3. 主键约束（`date_key`）防止重复插入
4. 自动递增逻辑在数据库函数中完成

**流程**：
1. 尝试插入新记录（`current_seq = 0`）
2. 如果冲突（记录已存在），则递增 `current_seq`
3. 如果是新记录，更新为 1
4. 返回序列号

---

## 📊 订单号格式

**格式**：`QM-YYYYMMDD-XXX`

- `QM`：固定前缀（Qimo 公司标识）
- `YYYYMMDD`：8 位日期（例如：20260121）
- `XXX`：3 位序列号，不足补零（例如：001, 012, 123）

**示例**：
- `QM-20260121-001`（2026年1月21日第1单）
- `QM-20260121-012`（2026年1月21日第12单）
- `QM-20260122-001`（2026年1月22日第1单）

---

## 🧪 测试要点

### 功能测试
- [ ] Step 1 页面加载时自动生成订单号
- [ ] 订单号格式正确（QM-YYYYMMDD-XXX）
- [ ] 提交表单时使用预生成的订单号
- [ ] 刷新页面不重新生成订单号（使用已生成的）
- [ ] 中途关闭页面，订单号不回收

### 并发测试
- [ ] 同时打开多个 Step 1 页面，每个页面生成不同的订单号
- [ ] 同一天多次创建订单，序列号递增（001, 002, 003...）
- [ ] 跨天创建订单，序列号重置为 001

### 约束测试
- [ ] 尝试在 payload 中传入 `order_no`，验证被丢弃
- [ ] 尝试更新订单的 `order_no`，验证被拦截
- [ ] 验证订单号永不重复

---

## 📝 修改文件清单

### 新增文件
1. `supabase/migrations/20240115000000_add_order_sequences.sql`
   - 创建 `order_sequences` 表
   - 创建 `generate_order_sequence()` 函数

### 修改文件
1. `lib/repositories/ordersRepo.ts`
   - 新增 `generateOrderNo()` 函数
   - 修改 `createOrder()` 函数（支持预生成订单号）
   - 修改 `sanitizePayload()` 函数（移除 `order_no` 白名单）
   - 修改 `updateOrder()` 函数（禁止更新 `order_no`）
   - 添加系统级约束注释

2. `app/actions/orders.ts`
   - 新增 `preGenerateOrderNo()` Server Action
   - 修改 `createOrder()` Server Action（移除 `order_no` 读取）

3. `app/orders/new/page.tsx`
   - 移除订单号输入框
   - 添加订单号预生成逻辑（页面加载时）
   - 添加订单号显示区域
   - 修改表单提交逻辑（使用预生成的订单号）

---

## ⚠️ 系统级约束总结

### 代码层约束
1. ✅ **任何地方禁止直接 insert orders 不带 order_no**
   - Repository 层强制生成
   - 白名单已移除 `order_no`

2. ✅ **任何地方禁止 update order_no**
   - `UPDATE_BLACKLIST` 包含 `order_no`
   - `updateOrder()` 函数检测并移除

3. ⚠️ **删除订单 ≠ 删除记录**
   - 当前：物理删除（`deleteOrder()`）
   - 建议：未来改为逻辑删除

### 数据库层约束
1. ✅ **order_sequences 表不允许删除**
   - 无 DELETE policy
   - 关键表，不允许回滚

2. ✅ **订单号生成事务安全**
   - PostgreSQL 函数确保原子性
   - `ON CONFLICT DO UPDATE` 防止并发重复

---

## 🚀 部署步骤

1. **运行数据库迁移**：
   ```sql
   -- 在 Supabase SQL Editor 中执行
   -- supabase/migrations/20240115000000_add_order_sequences.sql
   ```

2. **验证函数**：
   ```sql
   -- 测试函数是否正常工作
   SELECT public.generate_order_sequence(CURRENT_DATE);
   ```

3. **部署代码**：
   - 所有代码已通过 TypeScript 编译
   - 构建成功：`npm run build` ✓

4. **测试**：
   - 访问 `/orders/new`
   - 验证订单号自动生成
   - 验证订单号格式正确
   - 验证并发安全

---

## ✅ 完成状态

- ✅ Step 1：数据库迁移文件已创建
- ✅ Step 2：Repository 层订单号生成函数已实现
- ✅ Step 3：createOrder 函数已调整
- ✅ Step 4：New Order 向导已改造
- ✅ Step 5：系统级约束已落实（代码注释）

**构建状态**：✅ TypeScript 编译通过，构建成功

---

**文档版本**：v1.0  
**最后更新**：2024-01-15
