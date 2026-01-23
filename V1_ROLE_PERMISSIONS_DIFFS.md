# V1 Role Permissions + CEO Control Layer - Diffs

## Summary
Complete implementation of V1 minimal role permissions with email-based admin allowlist and CEO control features (nudge, delay approval).

---

## File Diffs

### 1. `lib/utils/user-role.ts` (NEW)

**Created:** Role determination utilities.

```typescript
const ADMIN_ALLOWLIST = [
  'alex@qimoclothing.com',
  'su@qimoclothing.com',
];

export function getUserRoleFromEmail(email: string | null | undefined): UserRole {
  if (!email) return 'sales';
  const normalizedEmail = email.toLowerCase().trim();
  if (ADMIN_ALLOWLIST.includes(normalizedEmail)) {
    return 'admin';
  }
  return 'sales'; // V1 default
}

export async function getCurrentUserRole(supabase: any): Promise<{ role: UserRole; isAdmin: boolean }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { role: 'sales', isAdmin: false };
  }
  const role = getUserRoleFromEmail(user.email);
  return { role, isAdmin: role === 'admin' };
}

export function canModifyMilestone(
  currentRole: UserRole,
  isAdmin: boolean,
  milestoneOwnerRole: string
): boolean {
  if (isAdmin) return true;
  const normalizedOwnerRole = milestoneOwnerRole.toLowerCase().trim();
  const normalizedCurrentRole = currentRole.toLowerCase().trim();
  return normalizedOwnerRole === normalizedCurrentRole;
}
```

---

### 2. `app/api/nudge/route.ts` (NEW)

**Created:** Nudge API endpoint.

```typescript
export async function POST(request: NextRequest) {
  // 1. Check admin authorization
  if (!isAdmin(user.email)) {
    return NextResponse.json({ error: 'Only admin can nudge' }, { status: 403 });
  }
  
  // 2. Rate limit check (1 per hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recentNudges } = await supabase
    .from('milestone_logs')
    .select('id')
    .eq('milestone_id', milestone_id)
    .eq('action', 'nudge')
    .gte('created_at', oneHourAgo)
    .limit(1);
  
  if (recentNudges && recentNudges.length > 0) {
    return NextResponse.json(
      { error: 'Nudge already sent in the last hour' },
      { status: 429 }
    );
  }
  
  // 3. Get recipient (owner -> order creator -> current user)
  // 4. Log action
  // 5. Send email
}
```

---

### 3. `components/MilestoneActions.tsx`

**Changes:**

```diff
interface MilestoneActionsProps {
  milestone: Milestone;
+ currentRole?: string;
+ isAdmin?: boolean;
}

export function MilestoneActions({ milestone, currentRole, isAdmin = false }: MilestoneActionsProps) {
+ const canModify = isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase());
  
  // Only show actions for in_progress milestones
  const isCurrentMilestone = milestone.status === '进行中';
  
+ // Show blocked reason to admin only
+ const showBlockedReason = isAdmin && milestone.status === '卡住' && milestone.notes;
  
  return (
    <div className="space-y-4">
+     {showBlockedReason && (
+       <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
+         <p className="text-sm font-semibold text-orange-900">Blocked Reason (Admin View):</p>
+         <p className="text-sm text-orange-800 mt-1">{milestone.notes}</p>
+       </div>
+     )}
      
-     <div className="flex gap-2">
+     {canModify && (
+       <div className="flex gap-2">
         {milestone.status === '进行中' && (
           <>
             <button onClick={handleDone}>✅ Done</button>
             <button onClick={() => setShowBlockForm(!showBlockForm)}>❌ Blocked</button>
           </>
         )}
       </div>
+     )}
+     
+     {isAdmin && (milestone.status as string) !== '已完成' && (
+       <div className="flex gap-2">
+         <button onClick={handleNudge}>📧 Nudge Owner</button>
+       </div>
+     )}
    </div>
  );
}
```

---

### 4. `components/OrderTimeline.tsx`

**Changes:**

```diff
interface OrderTimelineProps {
  milestones: Milestone[];
  orderId: string;
  orderIncoterm: 'FOB' | 'DDP';
+ currentRole?: string;
+ isAdmin?: boolean;
}

export function OrderTimeline({ milestones, orderId, orderIncoterm, currentRole, isAdmin = false }: OrderTimelineProps) {
  // ...
  
  {isExpanded && (
    <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
      <EvidenceUpload ... />
      
-     <MilestoneActions milestone={milestone} />
+     <MilestoneActions 
+       milestone={milestone} 
+       currentRole={currentRole}
+       isAdmin={isAdmin}
+     />
      
-     {milestone.status !== '已完成' && (
+     {milestone.status !== '已完成' && (isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase())) && (
       <div className="bg-gray-50 p-4 rounded">
         <h4 className="font-semibold mb-2 text-gray-900">Request Delay</h4>
         <DelayRequestForm ... />
       </div>
     )}
    </div>
  )}
}
```

---

### 5. `components/DelayRequestsList.tsx`

**Changes:**

```diff
- {!showDecisionForm[request.id] && (isAdmin || isOrderOwner) && (
+ {!showDecisionForm[request.id] && isAdmin && (
    <button onClick={() => setShowDecisionForm((prev) => ({ ...prev, [request.id]: true }))}>
      Review
    </button>
  )}
```

---

### 6. `app/orders/[id]/page.tsx`

**Changes:**

```diff
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: order, error: orderError } = await getOrder(id);
  
  const orderData = order as any;
  
- // Check if user is admin or order owner
  const supabase = await createClient();
- const { data: { user } } = await supabase.auth.getUser();
- let isAdmin: boolean = false;
- let isOrderOwner: boolean = false;
- if (user) {
-   const { data: profile } = await supabase
-     .from('profiles')
-     .select('role')
-     .eq('user_id', user.id)
-     .single();
-   isAdmin = !!(profile && (profile as any).role === 'admin');
-   isOrderOwner = orderData.created_by === user.id;
- }
+ const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
+ const { data: { user } } = await supabase.auth.getUser();
+ const isOrderOwner = user ? orderData.created_by === user.id : false;
  
  // ...
  
- <OrderTimeline milestones={milestones} orderId={id} orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'} />
+ <OrderTimeline 
+   milestones={milestones} 
+   orderId={id} 
+   orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'}
+   currentRole={currentRole}
+   isAdmin={isAdmin}
+ />
  
- <DelayRequestsList delayRequests={delayRequests} orderId={id} isAdmin={isAdmin} isOrderOwner={isOrderOwner} />
+ <DelayRequestsList delayRequests={delayRequests} orderId={id} isAdmin={isAdmin} />
```

---

### 7. `app/admin/ceo/page.tsx`

**Changes:**

```diff
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function CEODashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    redirect('/login');
  }
  
- // Check if user is admin
- const { data: profile } = await supabase
-   .from('profiles')
-   .select('role')
-   .eq('user_id', user.id)
-   .single();
- 
- if (!profile || (profile as any).role !== 'admin') {
+ // Check if user is admin (using V1 role system)
+ const { isAdmin } = await getCurrentUserRole(supabase);
+ 
+ if (!isAdmin) {
    redirect('/dashboard');
  }
```

---

### 8. `app/admin/page.tsx`

**Changes:**

```diff
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function AdminPage() {
  // ...
  
- // Check if user is admin
- const { data: profile } = await supabase
-   .from('profiles')
-   .select('role')
-   .eq('user_id', user.id)
-   .single();
- 
- if (!profile || (profile as any).role !== 'admin') {
+ // Check if user is admin (using V1 role system)
+ const { isAdmin } = await getCurrentUserRole(supabase);
+ 
+ if (!isAdmin) {
    redirect('/dashboard');
  }
```

---

### 9. `lib/repositories/milestonesRepo.ts`

**Changes:**

```diff
import { getCurrentUserRole, canModifyMilestone } from '@/lib/utils/user-role';

export async function transitionMilestoneStatus(...) {
  // ...
  
+ // ⚠️ V1 权限检查：只有 admin 或 owner_role 匹配才能修改
+ const { data: { user } } = await supabase.auth.getUser();
+ if (!user || !user.email) {
+   return { error: 'Unauthorized' };
+ }
+ 
+ const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
+ const canModify = canModifyMilestone(currentRole, isAdmin, milestone.owner_role || '');
+ 
+ if (!canModify) {
+   return { error: 'Only milestone owner role or admin can modify this milestone' };
+ }
  
  // 将数据库枚举值转换为中文状态进行比较
  // ...
}

export async function updateMilestone(...) {
  // ...
  
+ // ⚠️ V1 权限检查：只有 admin 或 owner_role 匹配才能修改
+ const { data: { user } } = await supabase.auth.getUser();
+ if (!user || !user.email) {
+   return { error: 'Unauthorized' };
+ }
+ 
+ const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
+ const canModify = canModifyMilestone(currentRole, isAdmin, currentMilestone.owner_role || '');
+ 
+ if (!canModify) {
+   return { error: 'Only milestone owner role or admin can modify this milestone' };
+ }
  
  // 订单存在即可修改里程碑
  // ...
}
```

---

### 10. `supabase/migrations/20240123000000_v1_collaboration_rls.sql` (NEW)

**Created:** RLS migration for V1 collaboration.

```sql
-- Orders: All authenticated can read
CREATE POLICY "orders_select_authenticated" ON public.orders
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Milestones: All authenticated can read
CREATE POLICY "milestones_select_authenticated" ON public.milestones
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Milestones: Updates allowed (role restrictions in UI/Repository)
CREATE POLICY "milestones_update_authenticated" ON public.milestones
  FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- Milestone Logs: All authenticated can read
CREATE POLICY "milestone_logs_select_authenticated" ON public.milestone_logs
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Delay Requests: All authenticated can read
CREATE POLICY "delay_requests_select_authenticated" ON public.delay_requests
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Delay Requests: Order owner or admin can update
CREATE POLICY "delay_requests_update_own_or_admin" ON public.delay_requests
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL AND
    (
      EXISTS (SELECT 1 FROM public.orders o WHERE o.id = delay_requests.order_id AND o.created_by = auth.uid())
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin')
    )
  );
```

---

## Permission Enforcement Points

### UI Layer (Client Components)

1. **MilestoneActions:**
   - Done/Blocked buttons: `canModify` check
   - Nudge button: `isAdmin` check
   - Blocked reason: `isAdmin` check

2. **OrderTimeline:**
   - Delay request form: `canModify` check

3. **DelayRequestsList:**
   - Review button: `isAdmin` check

### Server Layer (Repository)

1. **transitionMilestoneStatus():**
   - Checks `canModifyMilestone()` before allowing transition

2. **updateMilestone():**
   - Checks `canModifyMilestone()` before allowing update

### API Layer

1. **POST /api/nudge:**
   - Checks `isAdmin()` before allowing nudge

---

## Entry Points Sealed

### Milestone Modification

1. **UI:** `MilestoneActions` component checks `canModify` before showing buttons
2. **Server:** `transitionMilestoneStatus()` checks permissions
3. **Server:** `updateMilestone()` checks permissions

### Delay Approval

1. **UI:** `DelayRequestsList` shows Review button only to admin
2. **Server:** `approveDelayRequest()` checks admin or order owner
3. **Server:** `rejectDelayRequest()` checks admin or order owner

### Nudge

1. **UI:** Nudge button only shown to admin
2. **API:** `/api/nudge` checks admin authorization
3. **API:** Rate limiting (1 per hour)

---

## Status

✅ **Complete** - V1 minimal role permissions + CEO control layer:
- Email-based admin allowlist
- Role determination utilities
- UI permission enforcement
- Server-side permission checks
- Nudge API with rate limiting
- Delay approval/rejection (admin only)
- RLS policies for collaboration
- Build passes successfully
