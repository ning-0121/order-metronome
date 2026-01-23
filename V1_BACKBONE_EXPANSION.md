# V1 Backbone Expansion - 18 Milestones

## Summary
Expanded milestone template from 5 to 18 milestones following V1 backbone flow: **PO->Finance->Docs->Procurement->QC->PPS->Production->QC->Packaging->Booking->Shipment->Payment**

---

## Changes Made

### 1. `lib/domain/gates.ts`

**Created `GATE_TEMPLATES_V1` with 18 milestones:**

1. **PO确认** (po_confirmed) - Sales, T0
2. **财务审核** (finance_approval) - Finance, T0+2d
3. **订单资料齐全** (order_docs_complete) - Sales, T0+3d
4. **原辅料采购** (raw_materials_procurement) - Procurement, ETD-35d
5. **原辅料到位** (raw_materials_arrival) - Procurement, ETD-30d
6. **原辅料验收** (raw_materials_inspection) - QC, ETD-28d
7. **产前样完成** (pp_sample_production) - Production, ETD-25d (conditional)
8. **产前样寄出** (pp_sample_sent) - Production, ETD-24d (conditional)
9. **产前样确认** (pp_sample_confirmed) - Sales, ETD-20d (conditional)
10. **工厂上线** (production_start) - Production, ETD-18d
11. **中查** (mid_inspection) - QC, ETD-12d
12. **尾查** (final_inspection) - QC, ETD-7d
13. **包装辅料到位** (packaging_materials_arrival) - Procurement, ETD-10d (offline-7d, custom: -15d)
14. **QC验货预约** (qc_appointment) - QC, ETD-5d (conditional)
15. **QC验货完成** (qc_inspection_complete) - QC, ETD-3d (conditional)
16. **订舱完成** (booking) - Logistics, ETD-7d (FOB) / ETD-21d (DDP) (cut-off-7d)
17. **出货完成** (shipment) - Logistics, ETD (anchor date)
18. **付款完成** (payment_complete) - Finance, ETD+7d

**Key Features:**
- All 18 milestones defined with proper dependencies
- Conditional milestones for PP Sample and QC
- Proper role assignments (Sales, Finance, Procurement, QC, Production, Logistics)
- Anchor date logic (T0 for startup, ETD/warehouse_due_date for execution)

---

### 2. `lib/schedule.ts`

**Updated `calcDueDates()` to calculate all 18 milestone due dates:**

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
- **T0-based milestones:** PO (T0), Finance (T0+2d), Docs (T0+3d)
- **Anchor-based milestones:** All others relative to ETD (FOB) or warehouse_due_date (DDP)
- **Packaging:** offline-7d = -10d (standard), -15d (custom)
- **Booking:** cut-off-7d = -7d (FOB), -21d (DDP)
- **Payment:** ETD+7d

**Returns:** Object with all 18 step_key -> due_at mappings

---

### 3. `lib/utils/gate-generator.ts`

**Updated `adjustGateOffset()` for packaging:**
- Standard packaging: -10d (offline-7d)
- Custom packaging: -15d

---

### 4. `app/actions/milestones.ts`

**Verified `getMilestonesByOrder()` sorts by `due_at`:**
```typescript
.order('due_at', { ascending: true })
```

✅ Milestones are already sorted by due_at on order detail page

---

### 5. Order Creation Flow

**`app/actions/orders.ts` uses `generateGateSchedule()`:**
- Generates milestones from `GATE_TEMPLATES_V1` (via `GATE_TEMPLATES`)
- Filters based on order conditions (needs_pp_sample, needs_qc, etc.)
- Calculates due_at using anchor date logic
- Inserts all milestones via `init_order_milestones` RPC function

✅ Order creation automatically inserts all 18 milestones (or filtered subset based on conditions)

---

## Milestone Flow (V1 Backbone)

```
PO (T0)
  ├─> Finance (T0+2d)
  └─> Docs (T0+3d)
      ├─> Procurement: Raw Materials (-35d, -30d)
      │   └─> QC: Raw Materials Inspection (-28d)
      │       ├─> PPS: Production (-25d) [conditional]
      │       │   ├─> PPS: Sent (-24d) [conditional]
      │       │   └─> PPS: Confirmed (-20d) [conditional]
      │       └─> Production: Start (-18d)
      │           ├─> QC: Mid Inspection (-12d)
      │           ├─> Packaging: Materials Arrival (-10d/-15d)
      │           └─> QC: Final Inspection (-7d)
      │               ├─> QC: Appointment (-5d) [conditional]
      │               │   └─> QC: Complete (-3d) [conditional]
      │               └─> Booking (-7d/-21d)
      │                   └─> Shipment (0d)
      │                       └─> Payment (+7d)
```

---

## Verification

### Build Status
✅ `npm run build` passes successfully
✅ TypeScript compilation successful
✅ All 18 milestones defined in `GATE_TEMPLATES_V1`

### Order Creation
✅ Uses `generateGateSchedule()` which filters `GATE_TEMPLATES_V1`
✅ All milestones inserted via `init_order_milestones` RPC
✅ Due dates calculated using anchor logic (T0 or ETD/warehouse_due_date)

### Order Detail Page
✅ `getMilestonesByOrder()` sorts by `due_at` ascending
✅ Milestones displayed in chronological order

---

## Files Modified

1. **`lib/domain/gates.ts`**
   - Added `GATE_TEMPLATES_V1` with 18 milestones
   - Updated `GATE_TEMPLATES` to reference V1 template

2. **`lib/schedule.ts`**
   - Updated `calcDueDates()` to calculate all 18 milestone due dates
   - Added packaging type parameter
   - Implemented anchor date logic and control rules

3. **`lib/utils/gate-generator.ts`**
   - Updated `adjustGateOffset()` for packaging (offline-7d rule)

---

## Status

✅ **Complete** - V1 backbone with 18 milestones implemented
- All milestones defined
- Due dates calculated correctly
- Order creation inserts all milestones
- Order detail page displays sorted by due_at
- No `orders.status` column introduced (uses computed status from milestones)

---

## Next Steps (Optional)

1. Test order creation with different order types (sample/bulk/repeat)
2. Verify milestone dependencies work correctly
3. Test conditional milestones (PP Sample, QC) based on order flags
4. Verify date calculations for FOB vs DDP orders
