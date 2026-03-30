# CEO/Admin Control Layer Implementation

## Summary
Implemented CEO Dashboard page at `/admin/ceo` with comprehensive executive overview and control features.

---

## Files Created/Modified

### 1. `app/admin/ceo/page.tsx` (NEW)

**Created:** New CEO dashboard page with admin-only access.

**Features:**

1. **Admin Authentication:**
   - Checks user authentication
   - Verifies `profile.role === 'admin'`
   - Redirects non-admin users to `/dashboard`

2. **Summary Cards:**
   - Overdue Milestones (In Progress): Count of milestones with `status='进行中'` and `due_at < now`
   - Blocked Milestones: Count of milestones with `status='卡住'`
   - Pending Delay Requests: Count of delay_requests with `status='pending'`
   - Total Bottlenecks: Sum of all overdue/blocked milestones

3. **Overdue Milestones Section:**
   - Lists all milestones with `status='进行中'` and overdue
   - Shows: milestone name, order number, customer name, due date, owner role
   - Clickable links to order detail page with milestone anchor

4. **Blocked Milestones Section:**
   - Lists all milestones with `status='卡住'`
   - Shows: milestone name, order number, customer name, owner role, block reason
   - Clickable links to order detail page

5. **Pending Delay Requests Section:**
   - Lists all delay_requests with `status='pending'`
   - Shows: milestone name, order number, customer name, reason type, requested new due date, reason detail
   - Clickable links to order detail page with milestone anchor

6. **Bottleneck Summary by Role:**
   - Table showing count of overdue/blocked milestones per `owner_role`
   - Sorted by count (descending)

7. **Bottleneck Summary by User:**
   - Table showing count of overdue/blocked milestones per `owner_user_id`
   - Shows user name/email from profiles table
   - Includes "View Order" link for quick access
   - Handles unassigned milestones

---

## Data Queries

### Overdue Milestones
```typescript
const overdueMilestones = (allMilestones || []).filter((m: any) => {
  return m.status === '进行中' && m.due_at && isOverdue(m.due_at);
});
```

### Blocked Milestones
```typescript
const blockedMilestones = (allMilestones || []).filter((m: any) => {
  return m.status === '卡住';
});
```

### Pending Delay Requests
```typescript
const { data: pendingDelayRequests } = await (supabase
  .from('delay_requests') as any)
  .select(`
    *,
    milestones!inner (
      id,
      name,
      step_key,
      order_id,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    )
  `)
  .eq('status', 'pending')
  .order('created_at', { ascending: false });
```

### Bottleneck by Role
```typescript
const bottlenecksByRole: Record<string, number> = {};
(allMilestones || []).forEach((m: any) => {
  if (m.status === '卡住' || (m.status === '进行中' && m.due_at && isOverdue(m.due_at))) {
    const role = m.owner_role || 'unknown';
    bottlenecksByRole[role] = (bottlenecksByRole[role] || 0) + 1;
  }
});
```

### Bottleneck by User
```typescript
const bottlenecksByUser: Record<string, { count: number; user_id: string; milestones: any[] }> = {};
(allMilestones || []).forEach((m: any) => {
  if (m.status === '卡住' || (m.status === '进行中' && m.due_at && isOverdue(m.due_at))) {
    const userId = m.owner_user_id || 'unassigned';
    if (!bottlenecksByUser[userId]) {
      bottlenecksByUser[userId] = {
        count: 0,
        user_id: userId,
        milestones: [],
      };
    }
    bottlenecksByUser[userId].count += 1;
    bottlenecksByUser[userId].milestones.push(m);
  }
});
```

---

## UI/UX Features

1. **Visual Hierarchy:**
   - Summary cards at top (4 columns)
   - Sections with clear headings
   - Color-coded status indicators (red for overdue, orange for blocked, yellow for pending)

2. **Quick Links:**
   - All milestone items link to `/orders/{order_id}#milestone-{milestone_id}`
   - Delay requests link to order detail with milestone anchor
   - User bottleneck table includes "View Order" link

3. **Readability:**
   - Explicit background colors (`bg-white`, `bg-red-50`, etc.)
   - Text colors for contrast (`text-gray-900`, `text-gray-700`)
   - Hover effects on clickable items

4. **Responsive Design:**
   - Grid layout for summary cards (4 columns on md+)
   - Scrollable sections with max-height
   - Tables for bottleneck summaries

---

## Access Control

**Admin Check:**
```typescript
const { data: profile } = await supabase
  .from('profiles')
  .select('role')
  .eq('user_id', user.id)
  .single();

if (!profile || (profile as any).role !== 'admin') {
  redirect('/dashboard');
}
```

**Behavior:**
- Non-authenticated users → redirect to `/login`
- Non-admin users → redirect to `/dashboard`
- Admin users → access granted

---

## Key Differences from Regular Admin Page

1. **Focus:**
   - CEO Dashboard: Executive overview, bottlenecks, pending actions
   - Regular Admin: General admin functions, backfill tools

2. **Data Aggregation:**
   - CEO Dashboard: Aggregated by role and user
   - Regular Admin: Individual order/milestone analysis

3. **Action Items:**
   - CEO Dashboard: Highlights pending delay requests
   - Regular Admin: Focus on risk orders and overdue items

---

## Testing Checklist

- [ ] Access `/admin/ceo` as admin user → should load
- [ ] Access `/admin/ceo` as non-admin user → should redirect to `/dashboard`
- [ ] Access `/admin/ceo` as unauthenticated user → should redirect to `/login`
- [ ] Verify overdue milestones show correctly (in_progress + overdue)
- [ ] Verify blocked milestones show correctly
- [ ] Verify pending delay requests show correctly
- [ ] Verify bottleneck by role calculation
- [ ] Verify bottleneck by user calculation
- [ ] Verify all links navigate to correct order detail pages
- [ ] Verify summary card counts match section counts

---

## Status

✅ **Complete** - CEO Dashboard implemented:
- Admin-only access control
- Overdue milestones (in_progress + overdue)
- Blocked milestones
- Pending delay requests
- Bottleneck summary by role
- Bottleneck summary by user
- Quick links to order details
- Build passes successfully

---

## Route

**URL:** `/admin/ceo`

**Access:** Admin users only (`profile.role === 'admin'`)

**Navigation:** Add link in admin menu or navigation bar:
```tsx
<Link href="/admin/ceo">CEO Dashboard</Link>
```
