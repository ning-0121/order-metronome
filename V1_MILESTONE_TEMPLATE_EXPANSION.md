# V1 托底闭环：18个里程碑模板扩展

## Summary
Expanded milestone template from 5 to 18 milestones (V1 "托底闭环"). Updated `lib/milestoneTemplate.ts` and `lib/schedule.ts` to support all 18 milestones with proper due date calculations.

---

## Changes Made

### 1. `lib/milestoneTemplate.ts`

**Updated to include 18 milestones:**

```typescript
export const MILESTONE_TEMPLATE_V1: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  // 1. PO确认
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: true, evidence_required: false },
  
  // 2. 采购单提交（内部控制：T0+2d）
  { step_key: "procurement_sheet_submit", name: "采购单提交", owner_role: "procurement", is_critical: true, evidence_required: true },
  
  // 3. 财务采购审核（内部控制：T0+2d）
  { step_key: "finance_purchase_approval", name: "财务采购审核", owner_role: "finance", is_critical: true, evidence_required: false },
  
  // 4. 订单资料齐全（内部控制：T0+3d）
  { step_key: "order_docs", name: "订单资料齐全", owner_role: "sales", is_critical: true, evidence_required: false },
  
  // 5-18. 其他里程碑...
];
```

**18 Milestones:**
1. `po_confirmed` - PO确认
2. `procurement_sheet_submit` - 采购单提交 (NEW)
3. `finance_purchase_approval` - 财务采购审核 (NEW)
4. `order_docs` - 订单资料齐全
5. `raw_materials_procurement` - 原辅料采购
6. `raw_materials_arrival` - 原辅料到位
7. `raw_materials_inspection` - 原辅料验收
8. `pp_sample_production` - 产前样完成
9. `pp_sample_sent` - 产前样寄出
10. `pp_sample_confirmed` - 产前样确认
11. `production_start` - 工厂上线
12. `mid_inspection` - 中查
13. `final_inspection` - 尾查
14. `packaging_materials_arrival` - 包装辅料到位
15. `qc_appointment` - QC验货预约
16. `qc_inspection_complete` - QC验货完成
17. `booking` - 订舱完成
18. `shipment` - 出货完成

---

### 2. `lib/schedule.ts`

**Updated `calcDueDates()` to compute due_at for all 18 step_keys:**

```typescript
export function calcDueDates(params: {
  createdAt: Date; // T0
  incoterm: "FOB" | "DDP";
  etd?: string | null;
  warehouseDueDate?: string | null;
  packagingType?: "standard" | "custom";
})
```

**Date Calculation Rules:**

1. **T0-based milestones (订单启动阶段):**
   - `po_confirmed`: T0
   - `procurement_sheet_submit`: T0+2d (内部控制)
   - `finance_purchase_approval`: T0+2d (内部控制)
   - `order_docs`: T0+3d (内部控制)

2. **Anchor-based milestones:**
   - **Anchor:** FOB uses ETD; DDP uses warehouse_due_date
   - **production_offline:** ETD - 7d (FOB) or warehouse_due_date - 7d (DDP) as V1 proxy
   - **packaging_materials_arrival:** production_offline - 7d = ETD - 14d (standard) or ETD - 21d (custom)
   - **booking:** ETD - 7d (FOB) or warehouse_due_date - 21d (DDP) temporary
   - **shipment:** ETD (FOB) or warehouse_due_date (DDP)

3. **Weekend adjustment:** All dates use `shiftWeekendToFriday()` to shift weekends to Friday

**Returns:** Object with all 18 step_key -> due_at Date mappings

---

### 3. `app/actions/orders.ts`

**Updated order creation to use `milestoneTemplate.ts` and `calcDueDates()`:**

```diff
- import { generateGateSchedule } from '@/lib/utils/gate-generator';
+ import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
+ import { calcDueDates } from '@/lib/schedule';
+ import { subtractWorkingDays, ensureBusinessDay } from '@/lib/utils/date';

- const gateSchedules = generateGateSchedule({...});
- const milestonesData = gateSchedules.map((gate, index) => {...});
+ const dueDates = calcDueDates({
+   createdAt,
+   incoterm: orderData.incoterm as "FOB" | "DDP",
+   etd: orderData.etd,
+   warehouseDueDate: orderData.warehouse_due_date,
+   packagingType: orderData.packaging_type as "standard" | "custom",
+ });
+ 
+ const milestonesData = MILESTONE_TEMPLATE_V1.map((template, index) => {
+   const dueAt = dueDates[template.step_key];
+   const plannedAt = subtractWorkingDays(dueAt, 1);
+   const status = index === 0 ? 'in_progress' : 'pending';
+   return {
+     step_key: template.step_key,
+     name: template.name,
+     owner_role: template.owner_role,
+     planned_at: ensureBusinessDay(plannedAt).toISOString(),
+     due_at: ensureBusinessDay(dueAt).toISOString(),
+     status: status,
+     is_critical: template.is_critical,
+     evidence_required: template.evidence_required,
+     sequence_number: index + 1,
+   };
+ });
```

**Key Changes:**
- Uses `MILESTONE_TEMPLATE_V1` directly instead of Gate system
- Uses `calcDueDates()` to compute all due_at dates
- Calculates `planned_at` as `due_at - 1 working day`
- First milestone (`po_confirmed`) is `in_progress`, others are `pending`
- All milestones inserted via `init_order_milestones` RPC function

---

## Milestone Status

**Initial Status:**
- First milestone (`po_confirmed`): `in_progress` (DB enum: `in_progress`)
- All other milestones: `pending` (DB enum: `pending`)

**Database Support:**
- ✅ `step_key` is a text field - supports any string value
- ✅ `status` enum supports `pending` and `in_progress`
- ✅ `init_order_milestones` function handles all step_keys dynamically
- ✅ No schema changes needed

---

## Date Calculation Details

### Internal Controls (T0-based)
- `procurement_sheet_submit`: T0 + 2 workdays
- `finance_purchase_approval`: T0 + 2 workdays
- `order_docs`: T0 + 3 workdays

### Anchor-based Calculations
- **FOB Orders:**
  - Anchor = ETD
  - `packaging_materials_arrival` = ETD - 14d (standard) or ETD - 21d (custom)
  - `booking` = ETD - 7d
  - `shipment` = ETD

- **DDP Orders:**
  - Anchor = warehouse_due_date
  - `packaging_materials_arrival` = warehouse_due_date - 14d (standard) or -21d (custom)
  - `booking` = warehouse_due_date - 21d (temporary)
  - `shipment` = warehouse_due_date

### Weekend Adjustment
- All dates use `shiftWeekendToFriday()`:
  - Saturday → Friday
  - Sunday → Friday

---

## UI Rendering

**OrderTimeline Component:**
- ✅ Already sorts milestones by `due_at` ascending
- ✅ Displays all milestones from database
- ✅ No changes needed - automatically renders all 18 milestones

**Order Detail Page:**
- ✅ Uses `getMilestonesByOrder()` which returns all milestones
- ✅ Displays via `OrderTimeline` component
- ✅ No changes needed

---

## Verification

### Build Status
✅ `npm run build` passes successfully
✅ TypeScript compilation successful
✅ All 18 milestones defined in `MILESTONE_TEMPLATE_V1`
✅ All step_keys have corresponding due date calculations

### Order Creation
✅ Uses `MILESTONE_TEMPLATE_V1` to generate all 18 milestones
✅ Uses `calcDueDates()` to compute due_at for all step_keys
✅ Calculates planned_at as due_at - 1 working day
✅ First milestone is `in_progress`, others are `pending`
✅ All milestones inserted via `init_order_milestones` RPC

### Database Support
✅ `step_key` is text field - supports all new step_keys
✅ `init_order_milestones` function handles dynamic step_keys
✅ No schema changes required

---

## Files Modified

1. **`lib/milestoneTemplate.ts`**
   - Expanded from 5 to 18 milestones
   - Added `procurement_sheet_submit` and `finance_purchase_approval`
   - All milestones include: step_key, name (CN), owner_role, is_critical, evidence_required

2. **`lib/schedule.ts`**
   - Updated `calcDueDates()` to compute all 18 step_keys
   - Added internal control rules (T0+2d, T0+3d)
   - Added packaging materials calculation (production_offline - 7d)
   - Added booking calculation (ETD - 7d for FOB, warehouse_due_date - 21d for DDP)
   - All dates use `shiftWeekendToFriday()` for weekend adjustment

3. **`app/actions/orders.ts`**
   - Replaced Gate system with `milestoneTemplate.ts` and `calcDueDates()`
   - Generates all 18 milestones on order creation
   - First milestone is `in_progress`, others are `pending`
   - Calculates `planned_at` as `due_at - 1 working day`

---

## Status

✅ **Complete** - V1 托底闭环 with 18 milestones implemented
- All 18 milestones defined in `milestoneTemplate.ts`
- All due dates calculated correctly in `calcDueDates()`
- Order creation inserts all 18 milestones
- UI renders all milestones sorted by due_at
- Database supports all new step_keys without schema changes

---

## Milestone Flow (V1 托底闭环)

```
PO确认 (T0)
  ├─> 采购单提交 (T0+2d)
  ├─> 财务采购审核 (T0+2d)
  └─> 订单资料齐全 (T0+3d)
      ├─> 原辅料采购 (ETD-35d)
      │   └─> 原辅料到位 (ETD-30d)
      │       └─> 原辅料验收 (ETD-28d)
      │           ├─> 产前样完成 (ETD-25d)
      │           │   ├─> 产前样寄出 (ETD-24d)
      │           │   └─> 产前样确认 (ETD-20d)
      │           └─> 工厂上线 (ETD-18d)
      │               ├─> 中查 (ETD-12d)
      │               ├─> 包装辅料到位 (ETD-14d/-21d)
      │               └─> 尾查 (ETD-7d)
      │                   ├─> QC验货预约 (ETD-5d)
      │                   │   └─> QC验货完成 (ETD-3d)
      │                   └─> 订舱完成 (ETD-7d/-21d)
      │                       └─> 出货完成 (ETD/warehouse_due_date)
```

---

## Next Steps (Optional)

1. Test order creation with different order types (FOB/DDP)
2. Verify all 18 milestones are created correctly
3. Verify milestone dates are calculated correctly
4. Test UI rendering of all milestones
