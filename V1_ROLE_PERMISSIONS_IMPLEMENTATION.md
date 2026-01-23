# V1 Minimal Role Permissions + CEO Control Layer Implementation

## Summary
Implemented V1 minimal role permissions system with email-based admin allowlist and CEO control layer features (nudge, delay approval).

---

## Files Created/Modified

### 1. `lib/utils/user-role.ts` (NEW)

**Created:** Role determination utility functions.

**Functions:**

1. **`getUserRoleFromEmail(email)`**
   - Admin allowlist: `alex@qimoclothing.com`, `su@qimoclothing.com` => `role='admin'`
   - Others: default `role='sales'` (V1)
   - Returns: `UserRole`

2. **`isAdmin(email)`**
   - Checks if email is in admin allowlist
   - Returns: `boolean`

3. **`getCurrentUserRole(supabase)`**
   - Server-side function to get current user role
   - Returns: `{ role: UserRole, isAdmin: boolean }`

4. **`canModifyMilestone(currentRole, isAdmin, milestoneOwnerRole)`**
   - Checks if user can modify milestone
   - Returns `true` if: `isAdmin` OR `currentRole === milestoneOwnerRole`
   - Returns: `boolean`

**Admin Allowlist:**
```typescript
const ADMIN_ALLOWLIST = [
  'alex@qimoclothing.com',
  'su@qimoclothing.com',
];
```

---

### 2. `app/api/nudge/route.ts` (NEW)

**Created:** API route for sending nudge emails.

**Features:**
- **Authorization:** Only admin can nudge
- **Rate Limiting:** 1 nudge per milestone per hour
- **Email Recipients:**
  - Primary: Milestone owner (from `owner_user_id`)
  - Fallback: Order creator
  - Final fallback: Current user email
  - CC: su@qimoclothing.com, alex@qimoclothing.com
- **Logging:** Logs `nudge` action to `milestone_logs`

**Rate Limit Check:**
```typescript
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const { data: recentNudges } = await supabase
  .from('milestone_logs')
  .select('id')
  .eq('milestone_id', milestone_id)
  .eq('action', 'nudge')
  .gte('created_at', oneHourAgo)
  .limit(1);
```

**Email Content:**
- Subject: `[Nudge] Action Required: {milestone_name} - Order {order_no}`
- Body: Order details, milestone info, due date, status, link to milestone

---

### 3. `components/MilestoneActions.tsx`

**Changes:**

1. **Added Props:**
   ```typescript
   interface MilestoneActionsProps {
     milestone: Milestone;
     currentRole?: string;
     isAdmin?: boolean;
   }
   ```

2. **Permission Check:**
   ```typescript
   const canModify = isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase());
   ```

3. **Conditional Button Display:**
   - Done/Blocked buttons: Only show if `canModify === true`
   - Nudge button: Only show if `isAdmin === true` and milestone not completed

4. **Blocked Reason Display:**
   - Shows blocked reason only to admin
   - Displays in orange box with "Admin View" label

5. **Nudge Functionality:**
   - Calls `/api/nudge` endpoint
   - Shows loading state
   - Refreshes page after success

---

### 4. `components/OrderTimeline.tsx`

**Changes:**

1. **Added Props:**
   ```typescript
   interface OrderTimelineProps {
     milestones: Milestone[];
     orderId: string;
     orderIncoterm: 'FOB' | 'DDP';
     currentRole?: string;
     isAdmin?: boolean;
   }
   ```

2. **Pass Props to MilestoneActions:**
   ```typescript
   <MilestoneActions 
     milestone={milestone} 
     currentRole={currentRole}
     isAdmin={isAdmin}
   />
   ```

3. **Conditional Delay Request Form:**
   - Only shows if `isAdmin` OR `currentRole === milestone.owner_role`

---

### 5. `components/DelayRequestsList.tsx`

**Changes:**

1. **Review Button:**
   - Changed from `(isAdmin || isOrderOwner)` to `isAdmin` only
   - Only admin can approve/reject delay requests

---

### 6. `app/orders/[id]/page.tsx`

**Changes:**

1. **Get User Role:**
   ```typescript
   const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
   ```

2. **Pass Props:**
   - Passes `currentRole` and `isAdmin` to `OrderTimeline`
   - Passes `isAdmin` to `DelayRequestsList`

---

### 7. `app/admin/ceo/page.tsx`

**Changes:**

1. **Updated Admin Check:**
   ```typescript
   const { isAdmin } = await getCurrentUserRole(supabase);
   if (!isAdmin) {
     redirect('/dashboard');
   }
   ```

2. **Uses V1 role system** instead of checking profiles table

---

### 8. `app/admin/page.tsx`

**Changes:**

1. **Updated Admin Check:**
   - Uses `getCurrentUserRole()` instead of profiles table check

---

### 9. `supabase/migrations/20240123000000_v1_collaboration_rls.sql` (NEW)

**Created:** RLS migration for V1 collaboration model.

**Policies:**

1. **Orders:**
   - SELECT: All authenticated users can read
   - INSERT: All authenticated users can create
   - UPDATE: Order owner or admin

2. **Milestones:**
   - SELECT: All authenticated users can read
   - INSERT: All authenticated users (system via function)
   - UPDATE: All authenticated users (role restrictions enforced in UI/Repository)

3. **Milestone Logs:**
   - SELECT: All authenticated users can read
   - INSERT: All authenticated users

4. **Delay Requests:**
   - SELECT: All authenticated users can read
   - INSERT: All authenticated users
   - UPDATE: Order owner or admin

**Note:** Role-based restrictions are enforced in UI/Repository layer for V1. TODO: Tighten at DB level when `user_roles` table is implemented.

---

## Permission Matrix

### Milestone Actions

| Action | Owner Role Match | Admin | Other Users |
|--------|-----------------|-------|-------------|
| View | ✅ | ✅ | ✅ |
| Done | ✅ | ✅ | ❌ |
| Blocked | ✅ | ✅ | ❌ |
| Request Delay | ✅ | ✅ | ❌ |
| Nudge | ❌ | ✅ | ❌ |

### Delay Requests

| Action | Order Owner | Admin | Other Users |
|--------|-------------|-------|-------------|
| View | ✅ | ✅ | ✅ |
| Create | ✅ | ✅ | ✅ |
| Approve/Reject | ❌ | ✅ | ❌ |

### Orders & Milestones

| Action | All Authenticated Users |
|--------|------------------------|
| View | ✅ |
| Create Order | ✅ |
| Update Order | Order Owner or Admin |

---

## Nudge API

**Endpoint:** `POST /api/nudge`

**Request Body:**
```json
{
  "milestone_id": "uuid"
}
```

**Authorization:**
- Only admin users can call this endpoint
- Returns 403 if not admin

**Rate Limiting:**
- Checks `milestone_logs` for `action='nudge'` in last hour
- Returns 429 if rate limit exceeded

**Response:**
```json
{
  "success": true,
  "message": "Nudge sent successfully",
  "recipient_email": "user@example.com"
}
```

**Email:**
- To: Milestone owner (fallback: order creator)
- CC: su@qimoclothing.com, alex@qimoclothing.com
- Subject: `[Nudge] Action Required: {milestone_name} - Order {order_no}`
- Includes order details, milestone info, and link

---

## Role Determination Flow

1. **User logs in** → Supabase Auth provides `user.email`
2. **Check admin allowlist:**
   - If email in `ADMIN_ALLOWLIST` → `role='admin'`
   - Otherwise → `role='sales'` (V1 default)
3. **Expose in app:**
   - Server-side: `getCurrentUserRole(supabase)` → `{ role, isAdmin }`
   - Client-side: Pass `currentRole` and `isAdmin` as props

**TODO:** Later add `user_roles` table for proper role management.

---

## UI Permission Enforcement

### Milestone Cards

**Done/Blocked Buttons:**
```typescript
const canModify = isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase());

{canModify && (
  <button onClick={handleDone}>Done</button>
  <button onClick={handleBlock}>Blocked</button>
)}
```

**Delay Request Form:**
```typescript
{canModify && (
  <DelayRequestForm ... />
)}
```

**Nudge Button:**
```typescript
{isAdmin && (milestone.status as string) !== '已完成' && (
  <button onClick={handleNudge}>📧 Nudge Owner</button>
)}
```

**Blocked Reason:**
```typescript
{isAdmin && milestone.status === '卡住' && milestone.notes && (
  <div>Blocked Reason (Admin View): {milestone.notes}</div>
)}
```

---

## RLS Policies (V1 Collaboration)

### Orders
- **SELECT:** `auth.uid() IS NOT NULL` (all authenticated)
- **INSERT:** `auth.uid() IS NOT NULL` (all authenticated)
- **UPDATE:** Order owner OR admin

### Milestones
- **SELECT:** `auth.uid() IS NOT NULL` (all authenticated)
- **INSERT:** `auth.uid() IS NOT NULL` (all authenticated)
- **UPDATE:** `auth.uid() IS NOT NULL` (role restrictions in UI/Repository)

### Milestone Logs
- **SELECT:** `auth.uid() IS NOT NULL` (all authenticated)
- **INSERT:** `auth.uid() IS NOT NULL` (all authenticated)

### Delay Requests
- **SELECT:** `auth.uid() IS NOT NULL` (all authenticated)
- **INSERT:** `auth.uid() IS NOT NULL` (all authenticated)
- **UPDATE:** Order owner OR admin

**Note:** Role-based write restrictions are enforced in UI/Repository layer for V1. Database-level role matching will be added when `user_roles` table is implemented.

---

## Testing Checklist

- [ ] Admin (alex/su) can see all orders and milestones
- [ ] Sales user can see all orders and milestones
- [ ] Sales user can modify milestones where `owner_role='sales'`
- [ ] Sales user cannot modify milestones where `owner_role='finance'`
- [ ] Admin can modify any milestone
- [ ] Admin can see blocked reasons
- [ ] Admin can nudge milestone owners
- [ ] Nudge rate limiting works (1 per hour)
- [ ] Only admin can approve/reject delay requests
- [ ] Delay request form only shows for owner_role match or admin
- [ ] Nudge button only shows for admin
- [ ] Email notifications sent correctly

---

## Status

✅ **Complete** - V1 minimal role permissions + CEO control layer:
- Email-based admin allowlist
- Role determination utilities
- UI permission enforcement
- Nudge API with rate limiting
- Delay approval/rejection (admin only)
- RLS policies for collaboration
- Build passes successfully

---

## Key Diffs Summary

### `lib/utils/user-role.ts` (NEW)
- Admin allowlist: alex@qimoclothing.com, su@qimoclothing.com
- Default role: sales
- `getCurrentUserRole()` for server-side
- `canModifyMilestone()` for permission checks

### `app/api/nudge/route.ts` (NEW)
- POST endpoint for nudge
- Admin-only authorization
- Rate limiting (1 per hour)
- Email to milestone owner + CC

### `components/MilestoneActions.tsx`
- Added `currentRole` and `isAdmin` props
- Conditional button display based on permissions
- Nudge button (admin only)
- Blocked reason display (admin only)

### `components/OrderTimeline.tsx`
- Added `currentRole` and `isAdmin` props
- Passes props to MilestoneActions
- Conditional delay request form

### `components/DelayRequestsList.tsx`
- Review button: admin only (removed order owner)

### `app/orders/[id]/page.tsx`
- Uses `getCurrentUserRole()` to get role
- Passes role info to components

### `app/admin/ceo/page.tsx` & `app/admin/page.tsx`
- Uses `getCurrentUserRole()` for admin check

### `supabase/migrations/20240123000000_v1_collaboration_rls.sql` (NEW)
- RLS policies for collaboration
- All authenticated users can read
- Write restrictions in UI/Repository layer

---

## Future Improvements (TODO)

1. **User Roles Table:**
   - Create `user_roles` table
   - Store actual roles per user
   - Update `getUserRoleFromEmail()` to query table

2. **DB-Level Role Enforcement:**
   - Add role matching in RLS policies
   - Tighten milestone update policy
   - Add role-based SELECT restrictions if needed

3. **Role Management UI:**
   - Admin page to assign roles
   - Role assignment workflow
   - Role history tracking
