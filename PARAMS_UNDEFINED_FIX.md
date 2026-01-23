# Fix: params.id = undefined in Order Detail Page

## Problem
The order detail page shows `params.id = undefined`, meaning the route parameter is not being read correctly.

## Root Cause

### 1. Next.js 16 App Router Change ✅
**File:** `app/orders/[id]/page.tsx`
- **Issue:** In Next.js 15+, `params` is a **Promise** and must be awaited
- **Previous:** `params: { id: string }` (synchronous object)
- **Fix:** `params: Promise<{ id: string }>` and `const { id } = await params;`

### 2. Order ID Safety Check ✅
**File:** `app/orders/page.tsx`
- **Issue:** No validation that `order.id` exists before using it in the Link
- **Fix:** Added conditional check to show "No ID" if `order.id` is missing

### 3. Explicit ID Selection ✅
**File:** `app/actions/orders.ts` (`getOrders()`)
- **Issue:** Using `select('*')` which should work, but being explicit is safer
- **Fix:** Explicitly select `id` along with other required fields

---

## Files Changed

### 1. `app/orders/[id]/page.tsx`

**Change 1:** Update params type and await it

```diff
export default async function OrderDetailPage({
  params,
}: {
- params: { id: string };
+ params: Promise<{ id: string }>;
}) {
- const { data: order, error: orderError } = await getOrder(params.id);
+ const { id } = await params;
+ const { data: order, error: orderError } = await getOrder(id);
```

**Change 2:** Replace all `params.id` references with `id`

```diff
- const { data: milestones, error: milestonesError } = await getMilestonesByOrder(params.id);
- const { data: delayRequests, error: delayRequestsError } = await getDelayRequestsByOrder(params.id);
+ const { data: milestones, error: milestonesError } = await getMilestonesByOrder(id);
+ const { data: delayRequests, error: delayRequestsError } = await getDelayRequestsByOrder(id);
```

```diff
- <OrderLifecycle status={lifecycleStatus as any} orderId={params.id} />
+ <OrderLifecycle status={lifecycleStatus as any} orderId={id} />
```

```diff
- <OrderLifecycleActions
    status={lifecycleStatus as any}
-   orderId={params.id}
+   orderId={id}
    allMilestonesCompleted={allMilestonesCompleted}
  />
```

```diff
- <OrderTimeline milestones={milestones} orderId={params.id} orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'} />
+ <OrderTimeline milestones={milestones} orderId={id} orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'} />
```

```diff
- <DelayRequestsList delayRequests={delayRequests} orderId={params.id} />
+ <DelayRequestsList delayRequests={delayRequests} orderId={id} />
```

```diff
- <p><strong>params.id:</strong> {params.id}</p>
+ <p><strong>params.id:</strong> {id}</p>
```

---

### 2. `app/orders/page.tsx`

**Change:** Add safety check for `order.id` before rendering Link

```diff
                  <td className="border border-gray-300 px-4 py-2">
-                   <Link
-                     href={`/orders/${order.id}`}
-                     className="text-blue-600 hover:text-blue-700"
-                   >
-                     View
-                   </Link>
+                   {order.id ? (
+                     <Link
+                       href={`/orders/${order.id}`}
+                       className="text-blue-600 hover:text-blue-700"
+                     >
+                       View
+                     </Link>
+                   ) : (
+                     <span className="text-gray-400 text-sm">No ID</span>
+                   )}
                  </td>
```

**Reason:** Prevents navigation to `/orders/undefined` if `order.id` is missing

---

### 3. `app/actions/orders.ts` (`getOrders()`)

**Change:** Explicitly select `id` field

```diff
  const { data: orders, error } = await supabase
    .from('orders')
-   .select('*')
+   .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, lifecycle_status, activated_at, terminated_at, notes, created_at')
    .order('created_at', { ascending: false });
```

**Reason:** Ensures `id` is always included in the result, even if RLS or other factors might affect `select('*')`

---

## Verification

### Build Status
✅ `npm run build` passes successfully
✅ TypeScript compilation successful
✅ No type errors

### Expected Behavior

**Before Fix:**
- `params.id = undefined` → Order detail page shows debug page with undefined ID
- Navigation fails silently

**After Fix:**
- `params` is awaited → `id` is correctly extracted
- Order detail page receives valid UUID
- Navigation works correctly
- If `order.id` is missing in list, shows "No ID" instead of broken link

---

## Next.js Version Context

- **Next.js 16.1.1** is being used
- In Next.js 15+, route `params` in App Router are **Promises** that must be awaited
- This is a breaking change from Next.js 13/14 where `params` was a synchronous object

**Reference:**
- [Next.js 15 Release Notes - Route Params](https://nextjs.org/docs/app/api-reference/file-conventions/page#params)

---

## Testing Checklist

1. ✅ Click "View" on an order in the list
2. ✅ Verify order detail page loads with correct order data
3. ✅ Check that `params.id` is now a valid UUID (not undefined)
4. ✅ Verify milestones and delay requests load correctly
5. ✅ If an order has no `id`, verify "No ID" is shown instead of broken link

---

**Files Modified:**
1. `app/orders/[id]/page.tsx` - Await params Promise and use `id` variable
2. `app/orders/page.tsx` - Add safety check for `order.id`
3. `app/actions/orders.ts` - Explicitly select `id` field

**Status:** ✅ Fixed and ready for testing
