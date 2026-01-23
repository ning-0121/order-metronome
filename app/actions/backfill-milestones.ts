'use server';

/**
 * Backfill script: Add missing milestones to existing orders
 * 
 * This script checks all orders and if an order has < 18 milestones,
 * it inserts the missing step_keys with computed due dates.
 * 
 * Usage: Call from admin page or run as a one-time migration
 */

import { createClient } from '@/lib/supabase/server';
import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import { calcDueDates } from '@/lib/schedule';
import { ensureBusinessDay } from '@/lib/utils/date';

export async function backfillOrderMilestones(orderId: string) {
  const supabase = await createClient();
  
  // Get order
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (orderError || !order) {
    return { error: `Order not found: ${orderId}` };
  }
  
  const orderData = order as any;
  
  // Get existing milestones
  const { data: existingMilestones, error: milestonesError } = await supabase
    .from('milestones')
    .select('step_key')
    .eq('order_id', orderId);
  
  if (milestonesError) {
    return { error: `Failed to fetch milestones: ${milestonesError.message}` };
  }
  
  const existingStepKeys = new Set((existingMilestones as any[])?.map((m: any) => m.step_key) || []);
  
  // Check if all 18 milestones exist
  if (existingStepKeys.size >= 18) {
    return { data: { message: 'Order already has all 18 milestones', orderId } };
  }
  
  // Calculate due dates for all milestones
  const createdAt = new Date(orderData.created_at);
  let dueDates;
  try {
    dueDates = calcDueDates({
      createdAt,
      incoterm: orderData.incoterm as "FOB" | "DDP",
      etd: orderData.etd,
      warehouseDueDate: orderData.warehouse_due_date,
      packagingType: orderData.packaging_type as "standard" | "custom",
    });
  } catch (error: any) {
    return { error: `Failed to calculate due dates: ${error.message}` };
  }
  
  // Find missing milestones
  const missingMilestones = MILESTONE_TEMPLATE_V1.filter(
    template => !existingStepKeys.has(template.step_key)
  );
  
  if (missingMilestones.length === 0) {
    return { data: { message: 'No missing milestones', orderId } };
  }
  
  // Prepare missing milestones data
  const milestonesData = missingMilestones.map((template, index) => {
    const dueAt = dueDates[template.step_key as keyof typeof dueDates];
    if (!dueAt) {
      throw new Error(`Missing due date calculation for step_key: ${template.step_key}`);
    }
    
    // planned_at = due_at for V1
    const plannedAt = dueAt;
    
    // Status: pending (not_started) for all backfilled milestones
    const status = 'pending';
    
    // Find the sequence number (should be based on template order)
    const sequenceNumber = MILESTONE_TEMPLATE_V1.findIndex(t => t.step_key === template.step_key) + 1;
    
    return {
      step_key: template.step_key,
      name: template.name,
      owner_role: template.owner_role,
      owner_user_id: null,
      planned_at: ensureBusinessDay(plannedAt).toISOString(),
      due_at: ensureBusinessDay(dueAt).toISOString(),
      status: status,
      is_critical: template.is_critical,
      evidence_required: template.evidence_required,
      notes: null,
      sequence_number: sequenceNumber,
    };
  });
  
  // Insert missing milestones via RPC
  const { error: rpcError } = await (supabase.rpc as any)('init_order_milestones', {
    _order_id: orderId,
    _milestones_data: milestonesData,
  });
  
  if (rpcError) {
    return { error: `Failed to insert milestones: ${rpcError.message}` };
  }
  
  return {
    data: {
      message: `Backfilled ${missingMilestones.length} milestones`,
      orderId,
      inserted: missingMilestones.map(m => m.step_key),
    },
  };
}

/**
 * Backfill all orders that have < 18 milestones
 */
export async function backfillAllOrders() {
  const supabase = await createClient();
  
  // Get all orders
  const { data: orders, error: ordersError } = await supabase
    .from('orders')
    .select('id');
  
  if (ordersError || !orders) {
    return { error: `Failed to fetch orders: ${ordersError?.message}` };
  }
  
  const results = [];
  
  for (const order of orders as any[]) {
    const result = await backfillOrderMilestones(order.id);
    results.push({ orderId: order.id, ...result });
  }
  
  const successCount = results.filter(r => r.data && !r.error).length;
  const errorCount = results.filter(r => r.error).length;
  const skippedCount = results.filter(r => r.data?.message?.includes('already has all')).length;
  
  return {
    data: {
      total: orders.length,
      success: successCount,
      errors: errorCount,
      skipped: skippedCount,
      results,
    },
  };
}
