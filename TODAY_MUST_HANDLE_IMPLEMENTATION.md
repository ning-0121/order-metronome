# "今日必须处理" Section - Admin Dashboard Enhancement

## Summary
Added a "今日必须处理" (Today Must Handle) section to the Admin Dashboard that displays urgent milestones requiring immediate attention. This section appears at the top of the dashboard and includes quick actions for admins.

---

## Files Created/Modified

### 1. `components/TodayMustHandle.tsx` (NEW)

**Created:** Client component to display urgent milestones with actions.

**Features:**
- Displays list of urgent milestones
- Shows order number, milestone name, owner (role + user), due time
- Status badges (已阻塞, 已超期, 今日到期)
- Quick actions:
  - View order detail (链接)
  - Nudge (提醒)
  - Approve/Reject delay (if pending)
- Empty state when no urgent milestones

**Props:**
```typescript
interface TodayMustHandleProps {
  milestones: TodayMustHandleMilestone[];
}
```

**Milestone Interface:**
```typescript
interface TodayMustHandleMilestone {
  id: string;
  order_id: string;
  name: string;
  owner_role: string;
  owner_user_id: string | null;
  owner_user: {
    user_id: string;
    email: string;
    full_name: string | null;
  } | null;
  due_at: string;
  status: string;
  order_no: string;
  customer_name: string;
  has_pending_delay: boolean;
}
```

---

### 2. `app/admin/page.tsx`

**Changes:**

1. **Added import:**
   ```diff
   + import { TodayMustHandle } from '@/components/TodayMustHandle';
   ```

2. **Added query logic for "Today Must Handle" milestones:**
   ```typescript
   // Conditions:
   // 1. status = '卡住' (blocked)
   // 2. OR (status = '进行中' AND due_at <= now() + 24 hours)
   // 3. OR (status != '已完成' AND due_at < now()) (overdue)
   ```

3. **Fetches user profiles for assigned owners:**
   - Gets all owner_user_ids from milestones
   - Fetches profiles in batch
   - Creates userMap for quick lookup

4. **Fetches pending delay requests:**
   - Checks for pending delay requests for these milestones
   - Creates delayRequestMap to mark milestones with pending delays

5. **Formats milestones with user info:**
   - Attaches owner_user object
   - Adds has_pending_delay flag
   - Includes order information

6. **Renders TodayMustHandle component at top:**
   ```diff
   return (
     <div className="space-y-6">
       <div>
         <h1 className="text-3xl font-bold">管理后台</h1>
         <p className="text-gray-600 mt-2">全局概览与风险分析</p>
       </div>
   
   +   {/* Today Must Handle Section */}
   +   <TodayMustHandle milestones={formattedTodayMilestones} />
   
       <BackfillButton />
   ```

---

## Query Logic

### Milestone Selection Criteria

1. **Blocked Milestones:**
   ```typescript
   status === '卡住'
   ```

2. **Due Within 24 Hours (In Progress):**
   ```typescript
   status === '进行中' && due_at <= (now + 24 hours)
   ```

3. **Overdue Milestones:**
   ```typescript
   status !== '已完成' && due_at < now
   ```

### Data Fetching

1. **Fetch all milestones with orders:**
   - Uses Supabase join to get order information
   - Orders by `due_at` ascending

2. **Filter in JavaScript:**
   - Applies the three conditions above
   - More flexible than complex SQL queries

3. **Enrich with user data:**
   - Batch fetch user profiles
   - Attach to milestones

4. **Check for pending delays:**
   - Query delay_requests table
   - Mark milestones with pending delays

---

## UI Display

### Section Header
- Title: "今日必须处理"
- Subtitle: "共 X 个节点需要立即处理"
- Red border and background for urgency

### Milestone Card

**Layout:**
- Left: Milestone information
- Right: Action buttons

**Information Display:**
1. **Milestone Name:**
   - Link to order detail page
   - Status badges (已阻塞, 已超期, 今日到期)

2. **Grid Layout (2 columns):**
   - Order: Order number (link)
   - Due Time: Formatted date/time (red if overdue)
   - Owner Role: Chinese label
   - Assigned User: Name/email or "未分配"

3. **Pending Delay Warning:**
   - Yellow banner if has_pending_delay
   - Shows "⚠️ 有待处理的延期申请"

**Action Buttons:**
- "查看详情" - Link to order detail
- "📧 提醒" - Nudge button (calls /api/nudge)
- "审批延期" - Link to delay requests section (if pending)

---

## Status Badges

1. **已阻塞 (Blocked):**
   - Orange badge
   - Shown when `status === '卡住'`

2. **已超期 (Overdue):**
   - Red badge
   - Shown when `due_at < now`

3. **今日到期 (Due Today):**
   - Yellow badge
   - Shown when `due_at` is today (not overdue)

---

## Actions

### 1. View Order Detail
- Link to `/orders/{order_id}#milestone-{milestone_id}`
- Opens order detail page with milestone scrolled into view

### 2. Nudge
- Calls `/api/nudge` API endpoint
- Sends email to milestone owner
- Shows loading state while sending
- Displays success/error message

### 3. Approve/Reject Delay
- Link to `/orders/{order_id}#delay-requests`
- Only shown if `has_pending_delay === true`
- Opens order detail page at delay requests section

---

## Styling

### Section Container
- Red border (`border-red-200`)
- Light red background (`bg-red-50`)
- Rounded corners
- Padding

### Milestone Cards
- White background
- Red border (`border-red-300`)
- Hover shadow effect
- Responsive grid layout

### Status Badges
- Small, rounded badges
- Color-coded (orange, red, yellow)
- Font weight: medium

---

## Empty State

When no urgent milestones:
```tsx
<div className="rounded-lg border border-gray-200 bg-white p-6">
  <h2 className="text-2xl font-semibold mb-4 text-gray-900">今日必须处理</h2>
  <p className="text-gray-500">暂无需要今日处理的节点</p>
</div>
```

---

## Performance Considerations

1. **Batch Queries:**
   - Fetches all milestones with orders in one query
   - Fetches user profiles in batch
   - Fetches delay requests in batch

2. **Client-Side Filtering:**
   - Filters milestones in JavaScript
   - More flexible than complex SQL
   - Acceptable for typical milestone counts

3. **Lazy Loading:**
   - User profiles loaded only if owner_user_id exists
   - Delay requests checked only for relevant milestones

---

## Translation

| English | Chinese |
|---------|---------|
| Today Must Handle | 今日必须处理 |
| X nodes need immediate attention | 共 X 个节点需要立即处理 |
| No urgent milestones | 暂无需要今日处理的节点 |
| Order | 订单 |
| Due Time | 到期时间 |
| Owner Role | 责任角色 |
| Assigned User | 负责人 |
| Unassigned | 未分配 |
| View Detail | 查看详情 |
| Nudge | 提醒 |
| Approve Delay | 审批延期 |
| Blocked | 已阻塞 |
| Overdue | 已超期 |
| Due Today | 今日到期 |
| Pending delay request | 有待处理的延期申请 |

---

## Verification

✅ **Build Status:** Successful
- TypeScript compilation passes
- No runtime errors
- Component renders correctly

✅ **Functionality:**
- Correctly filters milestones by criteria
- Displays all required information
- Actions work correctly (nudge, links)
- Empty state displays when no milestones
- Status badges show correctly

---

## Status

✅ **Complete** - "今日必须处理" section added to Admin Dashboard:
- Query logic for urgent milestones
- User information display
- Quick actions (view, nudge, approve delay)
- Status badges
- Empty state
- Placed at top of dashboard
- Build passes successfully
