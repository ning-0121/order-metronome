'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { evaluateShipmentGate } from '@/lib/logistics/shipment-release';
import { isDoneStatus } from '@/lib/domain/types';

export async function getShipmentReleaseGate(orderId: string) {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return { error: '请先登录' };
  const db = createServiceRoleClient();
  const [{ data: fin }, { data: milestones }, { data: confirmations }, { data: packing }, { data: batches }] = await Promise.all([
    (db.from('order_financials') as any).select('allow_shipment').eq('order_id', orderId).maybeSingle(),
    (db.from('milestones') as any).select('id,step_key,status').eq('order_id', orderId).in('step_key', ['final_qc_check','final_qc_sales_check','inspection_release','booking_done']),
    (db.from('milestone_confirmations') as any).select('party_key,status,milestone_id').eq('order_id', orderId),
    (db.from('packing_lists') as any).select('id').eq('order_id', orderId).limit(1),
    (db.from('shipment_batches') as any).select('id').eq('order_id', orderId).limit(1),
  ]);
  const ms = (milestones || []) as any[];
  const conf = (confirmations || []) as any[];
  const qc = ms.find((m) => ['final_qc_check','final_qc_sales_check','inspection_release'].includes(m.step_key) && isDoneStatus(m.status));
  const booking = ms.find((m) => m.step_key === 'booking_done' && isDoneStatus(m.status));
  const confirmed = (party: string) => conf.some((c) => c.party_key === party && c.status === 'confirmed');
  return { data: evaluateShipmentGate({
    business_execution: { passed: confirmed('sales_exec') },
    qc: { passed: !!qc || confirmed('qc'), evidenceId: qc?.id },
    logistics: { passed: !!booking || (batches || []).length > 0, evidenceId: booking?.id },
    finance: { passed: fin?.allow_shipment === true },
    documents: { passed: (packing || []).length > 0, evidenceId: packing?.[0]?.id },
    packing: { passed: (batches || []).length > 0, evidenceId: batches?.[0]?.id },
  }) };
}
