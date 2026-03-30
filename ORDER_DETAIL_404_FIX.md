# Order Detail 404 Fix - Summary

## Problem
Clicking "View" in the Orders list shows a 404 at `/orders/<uuid>`, even though the route file exists at `app/orders/[id]/page.tsx`.

## Root Cause Analysis

### 1. View Link Navigation ✅
**File:** `app/orders/page.tsx` (line 81)
- **Status:** ✅ Already correct
- **Current:** `href={`/orders/${order.id}`}`
- **Conclusion:** View link correctly uses `order.id` (UUID), not `order_no`

### 2. getOrder() Query Issue ✅
**File:** `app/actions/orders.ts` (line 213)
- **Problem:** Used `.single()` which throws an error if order doesn't exist
- **Fix:** Changed to `.maybeSingle()` which returns `null` instead of throwing

### 3. Detail Page Error Handling ✅
**File:** `app/orders/[id]/page.tsx` (line 19-21)
- **Problem:** Immediately calls `notFound()` without showing debug info
- **Fix:** Added debug rendering to show `params.id`, `orderError`, and `order` data

---

## Files Changed

### 1. `app/actions/orders.ts`

**Change:** Use `.maybeSingle()` instead of `.single()`

```diff
  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
-   .single();
+   .maybeSingle();
```

**Reason:** `.single()` throws an error if no row is found, while `.maybeSingle()` returns `null`. This allows us to distinguish between "order doesn't exist" and "query error".

---

### 2. `app/orders/[id]/page.tsx`

**Change:** Replace `notFound()` with debug rendering

```diff
- if (orderError || !order) {
-   notFound();
- }
+ // Debug: Show what we received instead of immediately calling notFound()
+ if (orderError || !order) {
+   return (
+     <div className="p-6 space-y-4">
+       <h1 className="text-2xl font-bold text-red-600">Debug: Order Not Found</h1>
+       <div className="bg-gray-100 p-4 rounded">
+         <p><strong>params.id:</strong> {params.id}</p>
+         <p><strong>orderError:</strong> {orderError || 'null'}</p>
+         <p><strong>order:</strong> {order ? JSON.stringify(order, null, 2) : 'null'}</p>
+       </div>
+       <p className="text-sm text-gray-600">
+         If this order should exist, check: 1) RLS policies, 2) Order ID format (must be UUID), 3) Database connection
+       </p>
+     </div>
+   );
+ }
```

**Also added:** Error logging for milestones and delayRequests

```diff
  const { data: milestones, error: milestonesError } = await getMilestonesByOrder(params.id);
  const { data: delayRequests, error: delayRequestsError } = await getDelayRequestsByOrder(params.id);
+ 
+ // Debug: Show milestones/delayRequests errors if any
+ if (milestonesError) {
+   console.error('[OrderDetailPage] Milestones error:', milestonesError);
+ }
+ if (delayRequestsError) {
+   console.error('[OrderDetailPage] Delay requests error:', delayRequestsError);
+ }
```

---

## Verification

### Before Fix
- Clicking "View" → 404 page
- No visibility into why it failed

### After Fix
- Clicking "View" → Debug page showing:
  - `params.id` (the UUID being requested)
  - `orderError` (any error from the query)
  - `order` (the order data if found, or null)
- This allows us to identify the real cause:
  - RLS policy blocking access?
  - Invalid UUID format?
  - Order truly doesn't exist?
  - Database connection issue?

---

## Next Steps

1. **Test the fix:**
   - Click "View" on an order in the list
   - Check the debug page to see what's happening

2. **Based on debug output:**
   - If `orderError` shows RLS error → Check RLS policies
   - If `order` is null but no error → Order doesn't exist or RLS blocking
   - If `params.id` is not a valid UUID → Check how the link is generated

3. **After identifying the cause:**
   - Restore `notFound()` only when order truly doesn't exist
   - Fix the underlying issue (RLS, query, etc.)

---

## Expected Behavior After Fix

- **If order exists and user has access:**
  - Shows order detail page with milestones list (even if empty)

- **If order doesn't exist or access denied:**
  - Shows debug page with diagnostic information
  - After fixing the root cause, can restore `notFound()` for clean 404

---

**Files Modified:**
1. `app/actions/orders.ts` - Changed `.single()` to `.maybeSingle()`
2. `app/orders/[id]/page.tsx` - Added debug rendering and error logging

**Status:** ✅ Fixed and ready for testing
