# lifecycle_status Removal - Summary

## Problem
Error: `column orders.lifecycle_status does not exist`

## Solution
Removed all references to `lifecycle_status` from queries, types, and UI rendering. Orders list Status is now computed from milestones only (GREEN/YELLOW/RED).

---

## Files Changed

### 1. `app/actions/orders.ts`

**Change:** Removed `lifecycle_status` from `getOrders()` select query

```diff
  const { data: orders, error } = await supabase
    .from('orders')
-   .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, lifecycle_status, activated_at, terminated_at, notes, created_at')
+   .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, activated_at, terminated_at, notes, created_at')
    .order('created_at', { ascending: false });
```

---

### 2. `app/orders/[id]/page.tsx`

**Changes:**
- Removed `OrderLifecycle` and `OrderLifecycleActions` components
- Removed `lifecycleStatus` variable and display
- Removed lifecycle status from Order Details section

```diff
- import { OrderLifecycle } from '@/components/OrderLifecycle';
- import { OrderLifecycleActions } from '@/components/OrderLifecycleActions';

- const lifecycleStatus = (orderData.lifecycle_status || '草稿') as string;

- {/* 生命周期条 */}
- <OrderLifecycle status={lifecycleStatus as any} orderId={id} />

- {/* 生命周期操作按钮 */}
- <OrderLifecycleActions
-   status={lifecycleStatus as any}
-   orderId={id}
-   allMilestonesCompleted={allMilestonesCompleted}
- />

- <div>
-   <dt className="text-sm font-medium text-gray-500">生命周期状态</dt>
-   <dd className="text-sm font-semibold">{lifecycleStatus}</dd>
- </div>
```

---

### 3. `app/dashboard/page.tsx`

**Change:** Updated pending retrospective orders query to use `retrospective_required` and `retrospective_completed_at` instead of `lifecycle_status`

```diff
- // 模块 0：待复盘订单（最高优先级）- lifecycle_status='待复盘'
  const { data: pendingRetroOrders } = await (supabase
    .from('orders') as any)
    .select('*')
-   .eq('lifecycle_status', '待复盘')
+   .eq('retrospective_required', true)
+   .is('retrospective_completed_at', null)
+   .not('terminated_at', 'is', null)
    .order('terminated_at', { ascending: false });
```

---

### 4. `lib/repositories/ordersRepo.ts`

**Changes:** Removed all `lifecycle_status` checks and updates from lifecycle functions

#### `activateOrder()`
```diff
- // 校验：只有草稿状态才能激活
- if (order.lifecycle_status !== '草稿') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法激活。只有"草稿"状态的订单才能激活。` };
- }
+ // 校验：只有未激活的订单才能激活
+ if (order.activated_at) {
+   return { error: '订单已激活，无法重复激活。' };
+ }

- .update({
-   lifecycle_status: '已生效',
-   activated_at: new Date().toISOString(),
- })
+ .update({
+   activated_at: new Date().toISOString(),
+ })
```

#### `startExecution()`
```diff
- .select('lifecycle_status')
- if (order.lifecycle_status !== '已生效') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法开始执行。只有"已生效"状态的订单才能开始执行。` };
- }
+ .select('activated_at')
+ if (!order.activated_at) {
+   return { error: '订单未激活，无法开始执行。请先激活订单。' };
+ }
- .update({ lifecycle_status: '执行中' })
+ // startExecution 不再需要更新任何字段
```

#### `requestCancel()`
```diff
- .select('lifecycle_status')
- if (order.lifecycle_status !== '执行中') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法申请取消。只有"执行中"状态的订单才能申请取消。` };
- }
+ .select('activated_at, terminated_at')
+ if (!order.activated_at) {
+   return { error: '订单未激活，无法申请取消。' };
+ }
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法申请取消。' };
+ }
```

#### `decideCancel()`
```diff
- if (order.lifecycle_status !== '执行中') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法取消。只有"执行中"状态的订单才能取消。` };
- }
- .update({
-   lifecycle_status: '已取消',
-   terminated_at: ...,
- })
+ if (!order.activated_at || order.terminated_at) {
+   return { error: '订单状态不允许取消。只有已激活且未终结的订单才能取消。' };
+ }
+ .update({
+   terminated_at: ...,
+ })
```

#### `completeOrder()`
```diff
- if (order.lifecycle_status !== '执行中') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法完成。只有"执行中"状态的订单才能完成。` };
- }
- const updateData: any = {
-   lifecycle_status: '已完成',
-   terminated_at: ...,
- };
- if (order.retrospective_required) {
-   updateData.lifecycle_status = '待复盘';
- }
+ if (!order.activated_at) {
+   return { error: '订单未激活，无法完成。' };
+ }
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法完成。' };
+ }
+ const updateData: any = {
+   terminated_at: ...,
+ };
```

#### `submitRetrospective()`
```diff
- .select('lifecycle_status')
- if (order.lifecycle_status !== '待复盘') {
-   return { error: `订单状态为"${order.lifecycle_status}"，无法提交复盘。只有"待复盘"状态的订单才能提交复盘。` };
- }
- .update({
-   lifecycle_status: '已复盘',
-   retrospective_completed_at: ...,
- })
+ .select('terminated_at, retrospective_required, retrospective_completed_at')
+ if (!order.terminated_at) {
+   return { error: '订单未终结，无法提交复盘。' };
+ }
+ if (!order.retrospective_required) {
+   return { error: '该订单不需要复盘。' };
+ }
+ if (order.retrospective_completed_at) {
+   return { error: '该订单已完成复盘，无法重复提交。' };
+ }
+ .update({
+   retrospective_completed_at: ...,
+ })
```

**Comments Updated:**
- Updated function documentation comments to reflect new logic (using `activated_at`, `terminated_at`, `retrospective_required` instead of `lifecycle_status`)

---

### 5. `lib/repositories/milestonesRepo.ts`

**Changes:** Removed `lifecycle_status` checks, replaced with `activated_at` and `terminated_at` checks

#### `checkGateDependencies()` and `transitionMilestoneStatus()`
```diff
- .select('lifecycle_status')
- const orderStatus = order.lifecycle_status as OrderLifecycleStatus;
- if (!canModifyMilestones(orderStatus)) {
-   return { error: `订单状态为"${orderStatus}"，无法修改里程碑。...` };
- }
+ .select('activated_at, terminated_at')
+ if (!order.activated_at) {
+   return { error: '订单未激活，无法修改里程碑。请先激活订单。' };
+ }
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法修改里程碑。' };
+ }
```

---

### 6. `app/orders/[id]/retrospective/page.tsx`

**Changes:** Replaced `lifecycleStatus` with `needsRetrospective` and `isRetrospectiveCompleted` based on actual fields

```diff
- const lifecycleStatus = orderData.lifecycle_status || '草稿';
+ const needsRetrospective = orderData.retrospective_required && !orderData.retrospective_completed_at && orderData.terminated_at;
+ const isRetrospectiveCompleted = orderData.retrospective_completed_at;

- if (lifecycleStatus !== '待复盘' && lifecycleStatus !== '已复盘') {
+ if (!needsRetrospective && !isRetrospectiveCompleted) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
-         <p className="text-yellow-800">订单状态为"{lifecycleStatus}"，无法进行复盘。只有"待复盘"状态的订单才能进行复盘。</p>
+         <p className="text-yellow-800">该订单不需要复盘或尚未终结，无法进行复盘。</p>
        </div>
      </div>
    );
  }

- {lifecycleStatus === '已复盘' && retrospective && (
+ {isRetrospectiveCompleted && retrospective && (
    ...
  )}

- disabled={submitting || lifecycleStatus === '已复盘'}
+ disabled={submitting || isRetrospectiveCompleted}
- {submitting ? '提交中...' : lifecycleStatus === '已复盘' ? '已提交' : '提交复盘'}
+ {submitting ? '提交中...' : isRetrospectiveCompleted ? '已提交' : '提交复盘'}
```

---

## Verification

### Build Status
✅ `npm run build` passes successfully
✅ TypeScript compilation successful
✅ No references to `lifecycle_status` in app/ or lib/ directories

### Orders List Status
✅ Status is computed from milestones only using `computeOrderStatus()` (GREEN/YELLOW/RED)
✅ No dependency on `lifecycle_status` field

### Lifecycle Logic
✅ All lifecycle functions now use:
- `activated_at` to check if order is activated
- `terminated_at` to check if order is terminated
- `retrospective_required` and `retrospective_completed_at` for retrospective logic

---

## Summary

**Total Files Modified:** 6
1. `app/actions/orders.ts`
2. `app/orders/[id]/page.tsx`
3. `app/dashboard/page.tsx`
4. `lib/repositories/ordersRepo.ts`
5. `lib/repositories/milestonesRepo.ts`
6. `app/orders/[id]/retrospective/page.tsx`

**Status:** ✅ Complete - All `lifecycle_status` references removed, build passes
