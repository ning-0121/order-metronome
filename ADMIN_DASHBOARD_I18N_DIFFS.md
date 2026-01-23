# Admin Dashboard Internationalization (ZH-CN) - Diffs

## Summary
Converted all visible English UI text in the Admin Dashboard to Chinese (ZH-CN) according to business-appropriate labels.

---

## Files Modified

### 1. `lib/utils/i18n.ts` (NEW)

**Created:** Internationalization utility functions for UI labels.

```typescript
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'sales': '业务',
    'finance': '财务',
    'procurement': '采购',
    'production': '生产',
    'qc': '质检',
    'logistics': '物流',
    'admin': '管理员',
  };
  return roleMap[role.toLowerCase()] || role;
}

export function getStatusLabel(status: string): string {
  // Maps status labels for display only
  // ...
}
```

---

### 2. `app/admin/page.tsx`

**Changes:**

#### Header Section
```diff
- <h1 className="text-3xl font-bold">Admin Dashboard</h1>
- <p className="text-gray-600 mt-2">Overview and analysis</p>
+ <h1 className="text-3xl font-bold">管理后台</h1>
+ <p className="text-gray-600 mt-2">全局概览与风险分析</p>
```

#### Summary Cards
```diff
- <h3 className="text-lg font-semibold mb-2">Risk Orders</h3>
+ <h3 className="text-lg font-semibold mb-2">风险订单</h3>

- <h3 className="text-lg font-semibold mb-2">Overdue Milestones</h3>
+ <h3 className="text-lg font-semibold mb-2">已超期节点</h3>

- <h3 className="text-lg font-semibold mb-2">Blocked Milestones</h3>
+ <h3 className="text-lg font-semibold mb-2">已阻塞节点</h3>
```

#### Risk Orders List
```diff
- <h2 className="text-2xl font-semibold mb-4">Risk Orders</h2>
- <p className="text-gray-500">No risk orders</p>
+ <h2 className="text-2xl font-semibold mb-4">风险订单列表</h2>
+ <p className="text-gray-500">暂无风险订单</p>
```

#### Overdue Milestones List
```diff
- <h2 className="text-2xl font-semibold mb-4">Overdue Milestones</h2>
- <p className="text-gray-500">No overdue milestones</p>
+ <h2 className="text-2xl font-semibold mb-4">超期节点列表</h2>
+ <p className="text-gray-500">暂无超期节点</p>

- Order: {(milestone.orders as any)?.order_no} | Due: {formatDate(milestone.due_at)}
+ 订单: {(milestone.orders as any)?.order_no} | 应完成日期: {formatDate(milestone.due_at)}

- <div className="text-sm text-gray-500">Owner: {milestone.owner_role}</div>
+ <div className="text-sm text-gray-500">责任角色: {getRoleLabel(milestone.owner_role)}</div>
```

#### Bottleneck Analysis
```diff
- <h2 className="text-2xl font-semibold mb-4">Bottleneck Analysis by Role</h2>
- <p className="text-gray-500">No bottlenecks</p>
+ <h2 className="text-2xl font-semibold mb-4">角色瓶颈分析</h2>
+ <p className="text-gray-500">暂无瓶颈</p>

- <th className="text-left py-2">Role</th>
- <th className="text-left py-2">Overdue/Blocked Count</th>
+ <th className="text-left py-2">责任角色</th>
+ <th className="text-left py-2">超期/阻塞数量</th>

- <td className="py-2 font-medium">{role}</td>
+ <td className="py-2 font-medium">{getRoleLabel(role)}</td>
```

#### Import Added
```diff
+ import { getRoleLabel } from '@/lib/utils/i18n';
```

---

### 3. `components/BackfillButton.tsx`

**Changes:**

#### Title and Description
```diff
- <h3 className="text-lg font-semibold text-gray-900 mb-2">Milestone Backfill</h3>
- <p className="text-sm text-gray-600 mb-3">
-   Add missing milestones to existing orders that have less than 18 milestones.
- </p>
+ <h3 className="text-lg font-semibold text-gray-900 mb-2">订单节点补齐</h3>
+ <p className="text-sm text-gray-600 mb-3">
+   为已有订单补齐缺失的执行节点（少于18个的订单）
+ </p>
```

#### Button Text
```diff
- {loading ? 'Backfilling...' : 'Backfill All Orders'}
+ {loading ? '补齐中...' : '一键补齐所有订单节点'}
```

#### Confirmation Dialog
```diff
- if (!confirm('This will backfill milestones for all orders. Continue?')) {
+ if (!confirm('将为所有订单补齐缺失的执行节点，是否继续？')) {
```

#### Result Labels
```diff
- <p className="text-red-600 text-sm">Error: {result.error}</p>
+ <p className="text-red-600 text-sm">错误: {result.error}</p>

- <p><strong>Total:</strong> {result.data?.total}</p>
- <p><strong>Success:</strong> {result.data?.success}</p>
- <p><strong>Errors:</strong> {result.data?.errors}</p>
- <p><strong>Skipped:</strong> {result.data?.skipped}</p>
+ <p><strong>总计:</strong> {result.data?.total}</p>
+ <p><strong>成功:</strong> {result.data?.success}</p>
+ <p><strong>错误:</strong> {result.data?.errors}</p>
+ <p><strong>跳过:</strong> {result.data?.skipped}</p>
```

---

## Translation Mapping

### Page Titles
- `Admin Dashboard` → `管理后台`
- `Overview and analysis` → `全局概览与风险分析`

### Section Headers
- `Risk Orders` → `风险订单`
- `Overdue Milestones` → `已超期节点`
- `Blocked Milestones` → `已阻塞节点`
- `Risk Orders` (list) → `风险订单列表`
- `Overdue Milestones` (list) → `超期节点列表`
- `Bottleneck Analysis by Role` → `角色瓶颈分析`

### Labels
- `Order:` → `订单:`
- `Due:` → `应完成日期:`
- `Owner:` → `责任角色:`
- `Role` → `责任角色`
- `Overdue/Blocked Count` → `超期/阻塞数量`

### Empty States
- `No risk orders` → `暂无风险订单`
- `No overdue milestones` → `暂无超期节点`
- `No bottlenecks` → `暂无瓶颈`

### Backfill Component
- `Milestone Backfill` → `订单节点补齐`
- `Add missing milestones to existing orders that have less than 18 milestones.` → `为已有订单补齐缺失的执行节点（少于18个的订单）`
- `Backfill All Orders` → `一键补齐所有订单节点`
- `Backfilling...` → `补齐中...`
- `This will backfill milestones for all orders. Continue?` → `将为所有订单补齐缺失的执行节点，是否继续？`
- `Total:` → `总计:`
- `Success:` → `成功:`
- `Errors:` → `错误:`
- `Skipped:` → `跳过:`
- `Error:` → `错误:`

### Role Labels (via `getRoleLabel()`)
- `sales` → `业务`
- `finance` → `财务`
- `procurement` → `采购`
- `production` → `生产`
- `qc` → `质检`
- `logistics` → `物流`
- `admin` → `管理员`

---

## Key Implementation Details

1. **Role Label Mapping:**
   - Created `getRoleLabel()` utility function
   - Applied to all role displays in the dashboard
   - Only affects UI display, not database values

2. **Consistent Terminology:**
   - Used "节点" (node) for milestones
   - Used "订单" (order) consistently
   - Used "责任角色" (responsible role) for owner_role

3. **Empty States:**
   - All "No X" messages converted to "暂无X" pattern

4. **Table Headers:**
   - Converted to Chinese with proper spacing
   - Maintained table structure and styling

---

## Verification

✅ **Build Status:** Successful
- TypeScript compilation passes
- No runtime errors
- All UI text converted to Chinese

✅ **Scope Coverage:**
- Admin Dashboard page (`app/admin/page.tsx`)
- BackfillButton component (`components/BackfillButton.tsx`)
- All visible English text replaced

✅ **Database Safety:**
- No database values changed
- No enum values changed
- No step_keys changed
- Only UI display text modified

---

## Notes

- **Database Values:** All database values (enums, step_keys, status values) remain unchanged
- **Code Comments:** Code comments remain in English (not part of UI)
- **Error Messages:** Error messages from server actions remain in English (handled separately)
- **Layout:** Chinese text fits existing UI layout without adjustments needed

---

## Status

✅ **Complete** - Admin Dashboard UI fully internationalized to Chinese (ZH-CN):
- All visible English text converted
- Role labels mapped via utility function
- Empty states translated
- Button labels translated
- Table headers translated
- Build passes successfully
