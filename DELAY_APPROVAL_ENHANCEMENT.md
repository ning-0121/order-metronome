# Delay Approval Flow Enhancement for CEO

## Summary
Enhanced delay approval flow to allow CEO/Admin users to approve/reject delay requests with detailed information display and customer approval evidence tracking.

---

## Files Modified

### 1. `app/actions/delays.ts`

**Changes:**

1. **`approveDelayRequest()` - Admin Authorization:**
   ```typescript
   // Check authorization (order owner or admin)
   const { data: profile } = await supabase
     .from('profiles')
     .select('role')
     .eq('user_id', user.id)
     .single();
   
   const isAdmin = profile && (profile as any).role === 'admin';
   const isOrderOwner = orderData.created_by === user.id;
   
   if (!isOrderOwner && !isAdmin) {
     return { error: 'Only order owner or admin can approve delay requests' };
   }
   ```

2. **`rejectDelayRequest()` - Admin Authorization:**
   - Same authorization check as approveDelayRequest
   - Allows both order owner and admin to reject

**Existing Logic (Unchanged):**
- Updates `delay_requests.status='approved'` or `'rejected'`
- Sets `approved_by` and `approved_at`
- Runs `recalculateSchedule()` for approved requests
- Logs to `milestone_logs` with `approve_delay` or `reject_delay`
- Sends email notification to order owner + CC alex/su

---

### 2. `app/admin/ceo/page.tsx`

**Changes:**

1. **Enhanced Delay Request Display:**
   - Shows `reason_type` and `reason_detail`
   - Shows `proposed_new_anchor_date` if provided
   - Shows `proposed_new_due_at` if provided
   - Shows `requires_customer_approval` status
   - Shows `customer_approval_evidence_url` with link if exists
   - Visual indicators: ✓ Evidence provided / ⚠ No evidence

2. **Added DelayRequestActions Component:**
   - Integrated `DelayRequestActions` component for inline approval/rejection
   - Shows "Review" button that expands to approve/reject form

**Code:**
```typescript
{request.requires_customer_approval && (
  <div className="text-sm mt-2">
    <strong className="text-orange-700">Requires Customer Approval:</strong> Yes
    {request.customer_approval_evidence_url ? (
      <span className="ml-2 text-green-700">✓ Evidence provided</span>
    ) : (
      <span className="ml-2 text-red-700">⚠ No evidence</span>
    )}
  </div>
)}
{request.customer_approval_evidence_url && (
  <div className="text-sm text-gray-600 mt-1">
    <a
      href={request.customer_approval_evidence_url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 hover:text-blue-700"
    >
      View Customer Approval Evidence
    </a>
  </div>
)}
```

---

### 3. `components/DelayRequestActions.tsx` (NEW)

**Created:** Reusable component for delay request approval/rejection actions.

**Features:**
- "Review" button that expands to show form
- Textarea for decision note (required for reject, optional for approve)
- Approve button (green)
- Reject button (red, disabled if no note)
- Cancel button
- Loading states during processing
- Auto-refresh after action

**Usage:**
```tsx
<DelayRequestActions delayRequestId={request.id} />
```

---

### 4. `components/DelayRequestsList.tsx`

**Changes:**

1. **Added Interface Fields:**
   ```typescript
   interface DelayRequest {
     // ... existing fields
     requires_customer_approval?: boolean;
     customer_approval_evidence_url?: string | null;
   }
   
   interface DelayRequestsListProps {
     // ... existing props
     isAdmin?: boolean;
     isOrderOwner?: boolean;
   }
   ```

2. **Enhanced Display:**
   - Shows `reason_type` and `reason_detail` with labels
   - Shows `proposed_new_anchor_date` with label
   - Shows `proposed_new_due_at` with label
   - Shows `requires_customer_approval` status with visual indicators
   - Shows link to `customer_approval_evidence_url` if exists

3. **Conditional Review Button:**
   - Shows "Review" button only for admin or order owner
   - Button expands to show approve/reject form

**Code:**
```typescript
{request.requires_customer_approval && (
  <div className="text-sm mt-2">
    <strong className="text-orange-700">Requires Customer Approval:</strong> Yes
    {request.customer_approval_evidence_url ? (
      <span className="ml-2 text-green-700">✓ Evidence provided</span>
    ) : (
      <span className="ml-2 text-red-700">⚠ No evidence</span>
    )}
  </div>
)}
```

---

### 5. `app/orders/[id]/page.tsx`

**Changes:**

1. **Admin/Owner Check:**
   ```typescript
   // Check if user is admin or order owner
   const supabase = await createClient();
   const { data: { user } } = await supabase.auth.getUser();
   let isAdmin: boolean = false;
   let isOrderOwner: boolean = false;
   if (user) {
     const { data: profile } = await supabase
       .from('profiles')
       .select('role')
       .eq('user_id', user.id)
       .single();
     isAdmin = !!(profile && (profile as any).role === 'admin');
     isOrderOwner = orderData.created_by === user.id;
   }
   ```

2. **Pass Props to DelayRequestsList:**
   ```typescript
   <DelayRequestsList 
     delayRequests={delayRequests} 
     orderId={id} 
     isAdmin={isAdmin} 
     isOrderOwner={isOrderOwner} 
   />
   ```

---

## Approval/Rejection Flow

### On Approve:

1. **Authorization Check:**
   - Verifies user is order owner OR admin
   - Returns error if neither

2. **Update Delay Request:**
   - Sets `status='approved'`
   - Sets `approved_by=user.id`
   - Sets `approved_at=now()`
   - Sets `decision_note` (optional)

3. **Recalculate Schedule:**
   - If `proposed_new_anchor_date`: Updates order anchor date and recalculates all milestones
   - If `proposed_new_due_at`: Updates milestone due date and shifts downstream milestones

4. **Logging:**
   - Logs `approve_delay` action to `milestone_logs`
   - Logs `recalc_schedule` action if schedule was recalculated

5. **Email Notification:**
   - Sends to order owner
   - CC: su@qimoclothing.com, alex@qimoclothing.com
   - Subject: `[Approved] Delay Request - Order {order_no}`
   - Body includes order, milestone, decision note

6. **Revalidation:**
   - Revalidates order detail page
   - Revalidates admin pages

### On Reject:

1. **Authorization Check:**
   - Same as approve (order owner OR admin)

2. **Update Delay Request:**
   - Sets `status='rejected'`
   - Sets `approved_by=user.id`
   - Sets `approved_at=now()`
   - Sets `decision_note` (required)

3. **Logging:**
   - Logs `reject_delay` action to `milestone_logs`

4. **Email Notification:**
   - Sends to order owner
   - CC: su@qimoclothing.com, alex@qimoclothing.com
   - Subject: `[Rejected] Delay Request - Order {order_no}`
   - Body includes order, milestone, decision note

5. **Revalidation:**
   - Revalidates order detail page
   - Revalidates admin pages

---

## UI/UX Features

### CEO Dashboard (`/admin/ceo`)

1. **Pending Delay Requests Section:**
   - Lists all pending delay requests
   - Shows full details: reason type, reason detail, proposed dates
   - Shows customer approval requirement and evidence status
   - Inline approval/rejection with `DelayRequestActions` component
   - Links to order detail page

2. **Visual Indicators:**
   - Yellow background for pending requests
   - Green checkmark if evidence provided
   - Red warning if evidence missing
   - Blue link to view evidence

### Order Detail Page (`/orders/[id]`)

1. **Delay Requests List:**
   - Shows pending and processed requests separately
   - Full details for pending requests
   - Customer approval evidence link if exists
   - Review button for admin/order owner

2. **Approval Form:**
   - Expands when "Review" clicked
   - Decision note textarea
   - Approve/Reject buttons
   - Cancel button

---

## Customer Approval Evidence

**Display Logic:**
- If `requires_customer_approval=true`:
  - Shows "Requires Customer Approval: Yes"
  - If `customer_approval_evidence_url` exists: Shows "✓ Evidence provided" (green)
  - If `customer_approval_evidence_url` missing: Shows "⚠ No evidence" (red)
- If `customer_approval_evidence_url` exists:
  - Shows clickable link "View Customer Approval Evidence"
  - Opens in new tab

---

## Authorization Matrix

| User Type | Can Approve | Can Reject | Can View |
|-----------|-------------|------------|----------|
| Order Owner | ✅ | ✅ | ✅ |
| Admin | ✅ | ✅ | ✅ |
| Other Users | ❌ | ❌ | ✅ (if order owner) |

---

## Email Notifications

### Approval Email:
- **To:** Order owner email
- **CC:** su@qimoclothing.com, alex@qimoclothing.com
- **Subject:** `[Approved] Delay Request - Order {order_no}`
- **Body:** Includes order number, milestone name, decision note

### Rejection Email:
- **To:** Order owner email
- **CC:** su@qimoclothing.com, alex@qimoclothing.com
- **Subject:** `[Rejected] Delay Request - Order {order_no}`
- **Body:** Includes order number, milestone name, decision note

---

## Testing Checklist

- [ ] Admin can approve delay request from CEO dashboard
- [ ] Admin can reject delay request from CEO dashboard
- [ ] Admin can approve delay request from order detail page
- [ ] Order owner can approve delay request from order detail page
- [ ] Non-admin, non-owner cannot see Review button
- [ ] Customer approval evidence link works (if provided)
- [ ] Evidence status indicators show correctly
- [ ] Schedule recalculation works on approve
- [ ] Email notifications sent on approve/reject
- [ ] Milestone logs created correctly
- [ ] Decision note saved correctly

---

## Status

✅ **Complete** - Delay approval flow enhanced:
- Admin authorization added to approve/reject functions
- CEO dashboard shows detailed delay request info
- Customer approval evidence display
- Inline approval/rejection in CEO dashboard
- Enhanced DelayRequestsList with evidence display
- Build passes successfully

---

## Key Diffs Summary

### `app/actions/delays.ts`
- Added admin check to `approveDelayRequest()`
- Added admin check to `rejectDelayRequest()`

### `app/admin/ceo/page.tsx`
- Enhanced delay request display with all details
- Added customer approval evidence display
- Integrated `DelayRequestActions` component

### `components/DelayRequestActions.tsx` (NEW)
- Reusable approval/rejection component
- Inline form with decision note

### `components/DelayRequestsList.tsx`
- Added `requires_customer_approval` and `customer_approval_evidence_url` display
- Added `isAdmin` and `isOrderOwner` props
- Conditional Review button display

### `app/orders/[id]/page.tsx`
- Added admin/owner check
- Pass `isAdmin` and `isOrderOwner` to DelayRequestsList
