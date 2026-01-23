# Order Detail Timeline UI Improvement

## Summary
Improved the Order Detail timeline UI by grouping 18 milestones into 4 sections with visual emphasis for critical, overdue, and blocked milestones.

---

## Changes Made

### `components/OrderTimeline.tsx`

**Key Improvements:**

1. **Grouped Milestones into 4 Sections:**
   - **A. Order Setup Chain (订单启动链)**: 7 milestones
   - **B. PPS & Start Production (产前样与生产启动)**: 4 milestones
   - **C. Production → Shipping (生产与出货准备)**: 5 milestones
   - **D. Ship & Payment (出货与收款)**: 2 milestones

2. **Section Headers:**
   - Each section has a header with Chinese title and English subtitle
   - Border-bottom separator for visual distinction

3. **Enhanced Milestone Display:**
   - **Status Badge**: Color-coded status (未开始/进行中/已完成/卡住)
   - **Owner Role**: Displayed prominently
   - **Due Date**: Highlighted in red if overdue and in progress
   - **Planned Date**: Always shown
   - **Critical Badge**: Red badge for critical milestones
   - **Overdue Badge**: Red badge for overdue in-progress milestones
   - **Blocked Badge**: Orange badge for blocked milestones

4. **Visual Emphasis:**
   - **Critical milestones**: Red border (`border-red-200`)
   - **Overdue + In Progress**: Red border + red background tint (`border-red-400 border-2` + `bg-orange-50`)
   - **Blocked**: Orange border (`border-orange-400 border-2`) + orange background tint
   - **Normal milestones**: Gray border (`border-gray-200`)

5. **Improved Layout:**
   - Grid layout for milestone details (Owner, Due, Planned)
   - Better spacing and visual hierarchy
   - Evidence required indicator with icon (📎)
   - Blocked reason displayed in highlighted box

---

## Visual Features

### Section Headers
```
A. Order Setup Chain
订单启动链
────────────────────
```

### Milestone Card Structure
```
┌─────────────────────────────────────────────┐
│ Milestone Name    [Status] [Critical] [Badges] │
│                                                │
│ Owner: role    Due: date (red if overdue)     │
│ Planned: date                                  │
│                                                │
│ [Blocked reason box if blocked]              │
│                                                │
│ [View Details button]                         │
└─────────────────────────────────────────────┘
```

### Color Coding
- **Status Badges:**
  - 未开始: Gray (`bg-gray-100 text-gray-800`)
  - 进行中: Blue (`bg-blue-100 text-blue-800`)
  - 已完成: Green (`bg-green-100 text-green-800`)
  - 卡住: Orange (`bg-orange-100 text-orange-800`)

- **Border Colors:**
  - Normal: Gray (`border-gray-200`)
  - Critical: Light red (`border-red-200`)
  - Overdue + In Progress: Red (`border-red-400 border-2`)
  - Blocked: Orange (`border-orange-400 border-2`)

- **Background Tints:**
  - Overdue/Blocked: Light orange (`bg-orange-50`)

---

## Milestone Groups

### A. Order Setup Chain (订单启动链) - 7 milestones
1. `po_confirmed` - PO确认
2. `finance_approval` - 财务审核
3. `order_docs_complete` - 订单资料齐全
4. `rm_purchase_sheet_submit` - 原辅料采购单提交
5. `finance_purchase_approval` - 财务采购审核
6. `procurement_order_placed` - 采购订单下达
7. `materials_received_inspected` - 原辅料到货验收

### B. PPS & Start Production (产前样与生产启动) - 4 milestones
8. `pps_ready` - 产前样准备完成
9. `pps_sent` - 产前样寄出
10. `pps_customer_approved` - 产前样客户确认
11. `production_start` - 生产启动

### C. Production → Shipping (生产与出货准备) - 5 milestones
12. `mid_qc_check` - 中查
13. `final_qc_check` - 尾查
14. `packaging_materials_ready` - 包装辅料到位
15. `packing_labeling_done` - 包装贴标完成
16. `booking_done` - 订舱完成

### D. Ship & Payment (出货与收款) - 2 milestones
17. `shipment_done` - 出货完成
18. `payment_received` - 收款完成

---

## Sorting

- Milestones are sorted by `due_at` within each group
- Groups are displayed in order: Setup → PPS → Production → Ship

---

## Key Code Changes

### Added Milestone Groups Definition
```typescript
const MILESTONE_GROUPS = [
  {
    key: 'setup',
    title: 'A. Order Setup Chain',
    titleCn: '订单启动链',
    stepKeys: [...],
  },
  // ... other groups
];
```

### Grouped Milestones Logic
```typescript
const groupedMilestones = MILESTONE_GROUPS.map((group) => {
  const groupMilestones = milestones
    .filter((m) => group.stepKeys.includes(m.step_key))
    .sort((a, b) => {
      // Sort by due_at within each group
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });
  return { ...group, milestones: groupMilestones };
});
```

### Visual Emphasis Logic
```typescript
let borderColor = 'border-gray-200';
if (isBlocked) {
  borderColor = 'border-orange-400 border-2';
} else if (overdue && isInProgress) {
  borderColor = 'border-red-400 border-2';
} else if (isCritical) {
  borderColor = 'border-red-200';
}
```

### Enhanced Display
- Status badge with color coding
- Critical badge (red)
- Overdue badge (red, only for in-progress)
- Blocked badge (orange)
- Owner role displayed
- Due date highlighted if overdue
- Planned date always shown
- Evidence required indicator
- Blocked reason in highlighted box

---

## Benefits

1. **Better Organization**: Milestones grouped by logical phases
2. **Clear Visual Hierarchy**: Section headers and consistent styling
3. **Quick Status Identification**: Color-coded badges and borders
4. **Improved Readability**: Grid layout for details, better spacing
5. **Risk Visibility**: Overdue and blocked milestones stand out immediately

---

## Status

✅ **Complete** - Timeline UI improved with:
- 4 milestone groups with headers
- Status badges, owner_role, due_at, planned_at displayed
- Visual emphasis for critical, overdue, and blocked milestones
- Build passes successfully

---

## Testing

To verify:
1. Open an order detail page
2. Check that milestones are grouped into 4 sections
3. Verify section headers are displayed
4. Check that critical milestones have red borders
5. Verify overdue in-progress milestones have red borders and background
6. Check that blocked milestones have orange borders and background
7. Confirm all milestone details (status, owner, due, planned) are visible
