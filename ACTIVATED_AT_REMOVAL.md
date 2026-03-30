# activated_at Column Removal - Summary

## Problem
Runtime error: `column orders.activated_at does not exist`

## Solution
Removed all references to `activated_at` from Supabase queries, TypeScript types, and UI rendering. Replaced activation checks with termination checks where appropriate.

---

## Files Changed

### 1. `app/actions/orders.ts`

**Change:** Removed `activated_at` from `getOrders()` select query

```diff
  const { data: orders, error } = await supabase
    .from('orders')
-   .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, activated_at, terminated_at, notes, created_at')
+   .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, terminated_at, notes, created_at')
    .order('created_at', { ascending: false });
```

**Note:** Sorting already uses `created_at`, no change needed.

---

### 2. `app/orders/[id]/page.tsx`

**Change:** Removed display of `activated_at` field

```diff
- {orderData.activated_at && (
-   <div>
-     <dt className="text-sm font-medium text-gray-500">激活时间</dt>
-     <dd className="text-sm">{formatDate(orderData.activated_at)}</dd>
-   </div>
- )}
```

---

### 3. `lib/repositories/ordersRepo.ts`

#### `activateOrder()`
**Changes:**
- Removed check for `order.activated_at`
- Removed update of `activated_at` field
- Changed validation to check `terminated_at` instead

```diff
- // 校验：只有未激活的订单才能激活
- if (order.activated_at) {
-   return { error: '订单已激活，无法重复激活。' };
- }
+ // 校验：订单不能已终结
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法激活。' };
+ }

- // 更新订单：设置激活时间
- const { data: updated, error: updateError } = await (supabase
-   .from('orders') as any)
-   .update({
-     activated_at: new Date().toISOString(),
-   })
-   .eq('id', orderId)
-   .select()
-   .single();
+ // 激活订单：不需要更新字段，直接记录日志和更新里程碑
+ const updated = order;
```

**Updated function documentation:**
```diff
- * 1. 校验订单未激活才能激活
- * 2. 更新 orders：activated_at=now()
+ * 1. 校验订单未终结才能激活
+ * 2. 写 order_logs：action='activate'
```

#### `startExecution()`
**Changes:**
- Removed select of `activated_at`
- Removed check for `!order.activated_at`
- Changed validation to check `terminated_at` instead

```diff
- .select('activated_at')
- // 校验：只有已激活的订单才能开始执行
- if (!order.activated_at) {
-   return { error: '订单未激活，无法开始执行。请先激活订单。' };
- }
+ .select('terminated_at')
+ // 校验：订单不能已终结
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法开始执行。' };
+ }
```

#### `requestCancel()`
**Changes:**
- Removed `activated_at` from select
- Removed check for `!order.activated_at`
- Simplified validation to only check `terminated_at`

```diff
- .select('activated_at, terminated_at')
- // 校验：只有已激活且未终结的订单才能申请取消
- if (!order.activated_at) {
-   return { error: '订单未激活，无法申请取消。' };
- }
- if (order.terminated_at) {
+ .select('terminated_at')
+ // 校验：只有未终结的订单才能申请取消
+ if (order.terminated_at) {
    return { error: '订单已终结，无法申请取消。' };
  }
```

#### `decideCancel()`
**Changes:**
- Removed check for `!order.activated_at`
- Simplified validation to only check `terminated_at`

```diff
- // 校验订单状态：已激活且未终结
- if (!order.activated_at || order.terminated_at) {
-   return { error: '订单状态不允许取消。只有已激活且未终结的订单才能取消。' };
- }
+ // 校验订单状态：未终结
+ if (order.terminated_at) {
+   return { error: '订单已终结，无法取消。' };
+ }
```

#### `completeOrder()`
**Changes:**
- Removed check for `!order.activated_at`
- Simplified validation to only check `terminated_at`

```diff
- // 校验：只有已激活且未终结的订单才能完成
- if (!order.activated_at) {
-   return { error: '订单未激活，无法完成。' };
- }
- if (order.terminated_at) {
+ // 校验：只有未终结的订单才能完成
+ if (order.terminated_at) {
    return { error: '订单已终结，无法完成。' };
  }
```

---

### 4. `lib/repositories/milestonesRepo.ts`

#### `checkGateDependencies()` and `transitionMilestoneStatus()`
**Changes:**
- Removed `activated_at` from select queries
- Removed check for `!order.activated_at`
- Simplified validation to only check `terminated_at`

```diff
- .select('activated_at, terminated_at')
- // 只有已激活且未终结的订单才允许里程碑变更
- if (!order.activated_at) {
-   return { 
-     error: '订单未激活，无法修改里程碑。请先激活订单。' 
-   };
- }
- if (order.terminated_at) {
+ .select('terminated_at')
+ // 只有未终结的订单才允许里程碑变更
+ if (order.terminated_at) {
    return { 
      error: '订单已终结，无法修改里程碑。' 
    };
  }
```

---

## Logic Changes Summary

### Before
- Orders had an `activated_at` timestamp to track activation
- Functions checked `activated_at` to determine if order was activated
- Activation required setting `activated_at` field

### After
- No `activated_at` field tracking
- Functions check `terminated_at` to determine if order can be modified
- Activation is a logical state (order exists and is not terminated)
- All operations allowed as long as order is not terminated

### Validation Logic
- **Before:** `!order.activated_at` → Order not activated
- **After:** `order.terminated_at` → Order terminated (cannot modify)

---

## Verification

### Build Status
✅ `npm run build` passes successfully
✅ TypeScript compilation successful
✅ No references to `activated_at` in app/ or lib/ directories (excluding docs)

### Orders List Page
✅ `getOrders()` no longer selects `activated_at`
✅ Orders sorted by `created_at` (already was the case)
✅ Page loads normally and displays orders

### Order Detail Page
✅ No display of `activated_at` field
✅ Page renders correctly

### Repository Functions
✅ All functions updated to use `terminated_at` checks instead of `activated_at`
✅ Activation logic simplified (no database field update needed)

---

## Files Modified

1. **`app/actions/orders.ts`**
   - Removed `activated_at` from `getOrders()` select query

2. **`app/orders/[id]/page.tsx`**
   - Removed display of `activated_at` field

3. **`lib/repositories/ordersRepo.ts`**
   - Updated `activateOrder()`: Removed `activated_at` check and update
   - Updated `startExecution()`: Removed `activated_at` check
   - Updated `requestCancel()`: Removed `activated_at` check
   - Updated `decideCancel()`: Removed `activated_at` check
   - Updated `completeOrder()`: Removed `activated_at` check
   - Updated function documentation

4. **`lib/repositories/milestonesRepo.ts`**
   - Updated `checkGateDependencies()`: Removed `activated_at` check
   - Updated `transitionMilestoneStatus()`: Removed `activated_at` check

---

## Status

✅ **Complete** - All `activated_at` references removed
- No database column added
- All queries updated
- All validation logic updated
- Orders list page works correctly
- Build passes successfully

---

## Notes

- **Activation State:** Orders are now considered "activated" logically (they exist and are not terminated), rather than tracking a timestamp
- **Sorting:** Orders list already sorted by `created_at`, no change needed
- **Validation:** All validation now uses `terminated_at` as the single check for whether an order can be modified
