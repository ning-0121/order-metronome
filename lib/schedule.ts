import { subtractWorkingDays } from './utils/date';

function shiftWeekendToFriday(date: Date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun, 6 Sat
  if (day === 6) d.setDate(d.getDate() - 1); // Sat -> Fri
  if (day === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
  return d;
}

function addWorkdays(start: Date, days: number) {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

/**
 * V1.1 托底闭环：计算所有20个里程碑的due_at
 * A. Order Setup Chain (7)
 * B. PPS & Start Production (4)
 * C. Production → Shipping (7) - includes ship sample gates
 * D. Ship & Payment (2)
 */
export function calcDueDates(params: {
  createdAt: Date; // T0
  incoterm: "FOB" | "DDP";
  etd?: string | null; // YYYY-MM-DD
  warehouseDueDate?: string | null; // YYYY-MM-DD
  packagingType?: "standard" | "custom";
}) {
  const { createdAt, incoterm, etd, warehouseDueDate } = params;

  const T0 = createdAt;

  // Internal controls (T0-based)
  const financeApprovalDue = shiftWeekendToFriday(addWorkdays(T0, 2)); // T0+2d
  const orderDocsCompleteDue = shiftWeekendToFriday(addWorkdays(T0, 3)); // T0+3d
  const rmPurchaseSheetSubmitDue = shiftWeekendToFriday(addWorkdays(T0, 2)); // T0+2d
  const financePurchaseApprovalDue = shiftWeekendToFriday(addWorkdays(T0, 2)); // T0+2d

  // Anchor date (FOB ETD / DDP warehouse_due_date)
  const anchorStr = incoterm === "FOB" ? etd : warehouseDueDate;
  if (!anchorStr) {
    throw new Error(`Missing anchor date: ${incoterm === "FOB" ? "ETD" : "warehouse_due_date"} is required`);
  }

  const anchor = new Date(anchorStr + "T00:00:00");
  const anchorDate = shiftWeekendToFriday(anchor);

  // Helper: calculate days before anchor (negative = before)
  function daysBeforeAnchor(days: number): Date {
    const date = new Date(anchor);
    date.setDate(date.getDate() + days);
    return shiftWeekendToFriday(date);
  }

  // Helper: calculate days after anchor (positive = after)
  function daysAfterAnchor(days: number): Date {
    const date = new Date(anchor);
    date.setDate(date.getDate() + days);
    return shiftWeekendToFriday(date);
  }

  // For FOB, approximate production_offline = anchor - 7 days
  const productionOffline = daysBeforeAnchor(-7);

  // Production start due = production_offline - 20 days (default production cycle 20 days)
  const productionStartDue = daysBeforeAnchor(-27); // production_offline - 20 = anchor - 7 - 20 = anchor - 27

  // pps_customer_approved due = production_start - 2 workdays (blocks production start)
  const ppsCustomerApprovedDue = subtractWorkingDays(productionStartDue, 2);

  // pps_sent due = pps_customer_approved - 3 days (shipping buffer, weekend adjusted)
  const ppsSentDue = shiftWeekendToFriday(new Date(ppsCustomerApprovedDue.getTime() - 3 * 24 * 60 * 60 * 1000));

  // pps_ready due = pps_sent - 2 days
  const ppsReadyDue = shiftWeekendToFriday(new Date(ppsSentDue.getTime() - 2 * 24 * 60 * 60 * 1000));

  // procurement_order_placed due = production_start - 5 workdays
  const procurementOrderPlacedDue = subtractWorkingDays(productionStartDue, 5);

  // materials_received_inspected due = production_start - 2 workdays
  const materialsReceivedInspectedDue = subtractWorkingDays(productionStartDue, 2);

  // Packaging materials ready due = production_offline - 7 days
  const packagingMaterialsReadyDue = daysBeforeAnchor(-14); // production_offline - 7 = anchor - 7 - 7 = anchor - 14

  // mid_qc_check due = production_start + 10 days (midpoint)
  const midQcCheckDue = addWorkdays(productionStartDue, 10);

  // final_qc_check due = production_offline - 2 days
  const finalQcCheckDue = daysBeforeAnchor(-9); // production_offline - 2 = anchor - 7 - 2 = anchor - 9

  // packing_labeling_done due = production_offline - 1 day
  const packingLabelingDoneDue = daysBeforeAnchor(-8); // production_offline - 1 = anchor - 7 - 1 = anchor - 8

  // === Ship Sample Gates (V1.1) ===
  // booking_done due: FOB = anchor - 7 days, DDP = anchor - 21 days
  const bookingDoneDue = incoterm === "FOB" ? daysBeforeAnchor(-7) : daysBeforeAnchor(-21);

  // ship_sample_approved due = booking_done - 2 days
  const shipSampleApprovedDue = incoterm === "FOB"
    ? daysBeforeAnchor(-9) // -7 - 2 = -9
    : daysBeforeAnchor(-23); // -21 - 2 = -23

  // ship_sample_sent due = ship_sample_approved - 5 days
  const shipSampleSentDue = incoterm === "FOB"
    ? daysBeforeAnchor(-14) // -9 - 5 = -14
    : daysBeforeAnchor(-28); // -23 - 5 = -28

  // Shipment_done due = anchor (FOB ETD / DDP warehouse due)
  const shipmentDoneDue = anchorDate;

  // payment_received due = anchor + 30 days (temporary placeholder)
  const paymentReceivedDue = daysAfterAnchor(30);

  return {
    // A. Order Setup Chain (7)
    po_confirmed: shiftWeekendToFriday(T0),
    finance_approval: financeApprovalDue,
    order_docs_complete: orderDocsCompleteDue,
    rm_purchase_sheet_submit: rmPurchaseSheetSubmitDue,
    finance_purchase_approval: financePurchaseApprovalDue,
    procurement_order_placed: procurementOrderPlacedDue,
    materials_received_inspected: materialsReceivedInspectedDue,

    // B. PPS & Start Production (4)
    pps_ready: ppsReadyDue,
    pps_sent: ppsSentDue,
    pps_customer_approved: ppsCustomerApprovedDue,
    production_start: productionStartDue,

    // C. Production → Shipping (7)
    mid_qc_check: midQcCheckDue,
    final_qc_check: finalQcCheckDue,
    packaging_materials_ready: packagingMaterialsReadyDue,
    packing_labeling_done: packingLabelingDoneDue,
    ship_sample_sent: shipSampleSentDue,
    ship_sample_approved: shipSampleApprovedDue,
    booking_done: bookingDoneDue,

    // D. Ship & Payment (2)
    shipment_done: shipmentDoneDue,
    payment_received: paymentReceivedDue,
  };
}
