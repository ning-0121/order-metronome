# Delay Approval UI Enhancement (Business-Friendly) - Diffs

## Summary
Redesigned delay request detail view with business-friendly Chinese labels, date comparison, impacted milestones display, evidence attachments, and improved admin actions.

---

## Files Created/Modified

### 1. `components/DelayRequestDetail.tsx` (NEW)

**Created:** Enhanced delay request detail component with business-friendly UI.

**Features:**

1. **Reason Display:**
   - Reason type in Chinese (via REASON_TYPE_MAP)
   - Reason detail in long text format (whitespace-pre-wrap)

2. **Date Comparison:**
   - Original due_at (原定到期日)
   - Proposed new due_at (提议新到期日)
   - Delta days (变更天数) with color coding:
     - Red for positive (delay)
     - Green for negative (earlier)

3. **Impacted Milestones:**
   - Calculates and displays all affected downstream milestones
   - Shows current_due_at, new_due_at, and delta_days for each
   - Scrollable list (max-h-64)
   - Only visible to admin

4. **Evidence Attachments:**
   - Shows customer approval evidence if required
   - Link to view evidence file
   - Warning if evidence missing

5. **Admin Actions:**
   - Approve button (批准延期)
   - Reject button (拒绝延期) - requires decision_note
   - Decision note textarea (审批意见)
   - All labels in Chinese

**Props:**
```typescript
interface DelayRequestDetailProps {
  delayRequest: DelayRequest;
  isAdmin: boolean;
}
```

**Reason Type Mapping:**
```typescript
const REASON_TYPE_MAP: Record<string, string> = {
  'customer_confirmation': '客户确认',
  'supplier_delay': '供应商延迟',
  'internal_delay': '内部延迟',
  'logistics': '物流问题',
  'force_majeure': '不可抗力',
  'other': '其他',
};
```

---

### 2. `app/actions/delays.ts`

**Changes:**

1. **Added `getImpactedMilestones()` function:**
   ```typescript
   export async function getImpactedMilestones(delayRequestId: string)
   ```
   - Calculates impacted milestones for a delay request
   - Handles two scenarios:
     - Anchor date change: Recalculates all milestones
     - Single milestone change: Shifts downstream milestones
   - Returns array of impacted milestones with:
     - id, name, step_key
     - current_due_at, new_due_at
     - delta_days

2. **Updated `getDelayRequestsByOrder()`:**
   ```diff
   .select(`
     *,
   + milestones!inner(
   +   id,
   +   name,
   +   due_at
   + )
   `)
   ```
   - Now includes milestone information in query
   - Allows displaying original due_at in UI

---

### 3. `components/DelayRequestsList.tsx`

**Changes:**

1. **Replaced old detail view with DelayRequestDetail:**
   ```diff
   - {pendingRequests.map((request) => (
   -   <div key={request.id} className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 mb-4">
   -     {/* Old simple view */}
   -   </div>
   - ))}
   + {pendingRequests.map((request) => (
   +   <DelayRequestDetail
   +     key={request.id}
   +     delayRequest={request}
   +     isAdmin={isAdmin}
   +   />
   + ))}
   ```

2. **Updated labels to Chinese:**
   ```diff
   - <h3 className="text-lg font-semibold mb-2 text-gray-900">Pending Requests</h3>
   + <h3 className="text-lg font-semibold mb-4 text-gray-900">待审批延期申请</h3>
   
   - <h3 className="text-lg font-semibold mb-2 text-gray-900">Processed Requests</h3>
   + <h3 className="text-lg font-semibold mb-2 text-gray-900">已处理延期申请</h3>
   
   - {request.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
   + {request.status === 'approved' ? '✓ 已批准' : '✗ 已拒绝'}
   
   - Note: <span className="text-gray-900">{request.decision_note}</span>
   + 审批意见: <span className="text-gray-900">{request.decision_note}</span>
   
   - {request.status === 'approved' ? 'Approved' : 'Rejected'} at:
   + {request.status === 'approved' ? '批准' : '拒绝'}时间:
   
   - <p className="text-gray-500 bg-gray-50 p-4 rounded">No delay requests</p>
   + <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无延期申请</p>
   ```

3. **Added import:**
   ```diff
   + import { DelayRequestDetail } from './DelayRequestDetail';
   ```

4. **Updated DelayRequest interface:**
   ```diff
   interface DelayRequest {
     ...
   + milestone?: {
   +   id: string;
   +   name: string;
   +   due_at: string;
   + };
   }
   ```

---

### 4. `app/orders/[id]/page.tsx`

**Changes:**

```diff
- <h2 className="text-2xl font-semibold mb-4 text-gray-900">延迟申请</h2>
+ <h2 className="text-2xl font-semibold mb-4 text-gray-900">延期申请</h2>
```

---

## UI Components

### DelayRequestDetail Layout

```
┌─────────────────────────────────────────┐
│ 延期申请详情                    [审批]  │
├─────────────────────────────────────────┤
│ 延期原因                                │
│ ┌─────────────────────────────────────┐│
│ │ 原因类型: 客户确认                    ││
│ │ 详细说明:                            ││
│ │ [Long text in gray box]              ││
│ └─────────────────────────────────────┘│
├─────────────────────────────────────────┤
│ 日期变更对比                            │
│ ┌──────┬──────┬──────┐                 │
│ │ 原定 │ 提议 │ 变更 │                 │
│ │ 到期 │ 新到 │ 天数 │                 │
│ │ 日   │ 期日 │      │                 │
│ └──────┴──────┴──────┘                 │
├─────────────────────────────────────────┤
│ 受影响的后续节点 (Admin only)           │
│ ┌─────────────────────────────────────┐│
│ │ [Milestone 1]                        ││
│ │ 原定: ... 新日期: ... 变更: +3 天   ││
│ │ [Milestone 2]                        ││
│ │ ...                                  ││
│ └─────────────────────────────────────┘│
├─────────────────────────────────────────┤
│ 客户审批证据                            │
│ ┌─────────────────────────────────────┐│
│ │ ✓ 已提供证据                         ││
│ │ [View evidence file →]               ││
│ └─────────────────────────────────────┘│
├─────────────────────────────────────────┤
│ 审批操作 (Admin only)                   │
│ ┌─────────────────────────────────────┐│
│ │ 审批意见 *                           ││
│ │ [Textarea]                           ││
│ │ [批准延期] [拒绝延期] [取消]         ││
│ └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

---

## Date Comparison Display

### Grid Layout (3 columns)

1. **原定到期日 (Original Due Date):**
   - Shows milestone's current `due_at`
   - Format: `yyyy-MM-dd HH:mm`

2. **提议新到期日 (Proposed New Due Date):**
   - Shows `proposed_new_due_at` or `proposed_new_anchor_date`
   - Format: `yyyy-MM-dd HH:mm`

3. **变更天数 (Delta Days):**
   - Calculated: `(proposed - original) / (1000 * 60 * 60 * 24)`
   - Display:
     - `+X 天` (red) if positive
     - `-X 天` (green) if negative
     - `无变更` if zero

---

## Impacted Milestones Calculation

### Scenario 1: Anchor Date Change

If `proposed_new_anchor_date` exists:
1. Recalculate all milestones using `calcDueDates()`
2. Compare new dates with current dates
3. Calculate delta for each milestone
4. Display all milestones with changes

### Scenario 2: Single Milestone Change

If `proposed_new_due_at` exists:
1. Calculate delta for current milestone
2. Find downstream milestones (`due_at >= current_milestone.due_at`)
3. Apply same delta to downstream milestones
4. Display current + downstream milestones

---

## Evidence Display

### If `requires_customer_approval === true`:

**With Evidence:**
```
✓ 已提供证据
[View evidence file →]
```

**Without Evidence:**
```
⚠️ 未提供客户审批证据
[Red warning box]
```

---

## Admin Actions

### Approve Button
- Label: "✓ 批准延期"
- Color: Green
- Action: Calls `approveDelayRequest()`
- Note: Optional (can be empty)

### Reject Button
- Label: "✗ 拒绝延期"
- Color: Red
- Action: Calls `rejectDelayRequest()`
- Note: **Required** (disabled if empty)

### Decision Note
- Label: "审批意见 *"
- Placeholder: "请输入审批意见（拒绝时必须填写）..."
- Required for reject, optional for approve

---

## Translation Mapping

| English | Chinese |
|---------|---------|
| Delay Request Detail | 延期申请详情 |
| Reason Type | 原因类型 |
| Reason Detail | 详细说明 |
| Date Comparison | 日期变更对比 |
| Original Due Date | 原定到期日 |
| Proposed New Due Date | 提议新到期日 |
| Delta Days | 变更天数 |
| Impacted Milestones | 受影响的后续节点 |
| Customer Approval Evidence | 客户审批证据 |
| Evidence Provided | 已提供证据 |
| No Evidence | 未提供客户审批证据 |
| View Evidence File | 查看证据文件 |
| Admin Actions | 审批操作 |
| Decision Note | 审批意见 |
| Approve Delay | 批准延期 |
| Reject Delay | 拒绝延期 |
| Cancel | 取消 |
| Processing... | 处理中... |
| Pending Requests | 待审批延期申请 |
| Processed Requests | 已处理延期申请 |
| Approved | 已批准 |
| Rejected | 已拒绝 |
| No delay requests | 暂无延期申请 |

### Reason Types

| English | Chinese |
|---------|---------|
| customer_confirmation | 客户确认 |
| supplier_delay | 供应商延迟 |
| internal_delay | 内部延迟 |
| logistics | 物流问题 |
| force_majeure | 不可抗力 |
| other | 其他 |

---

## Verification

✅ **Build Status:** Successful
- TypeScript compilation passes
- No runtime errors
- All components render correctly

✅ **Functionality:**
- Reason type displays in Chinese
- Reason detail shows in formatted box
- Date comparison displays correctly
- Delta days calculated and color-coded
- Impacted milestones calculated and displayed
- Evidence attachments shown if present
- Admin actions work correctly
- All labels in Chinese

---

## Status

✅ **Complete** - Delay approval UI enhancement:
- Business-friendly Chinese labels
- Date comparison with delta calculation
- Impacted milestones display
- Evidence attachments display
- Improved admin actions
- Build passes successfully
