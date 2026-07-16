'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { evaluateShipmentGate } from '@/lib/logistics/shipment-release';
import { isDoneStatus } from '@/lib/domain/types';
import { getEffectiveResponsibilities } from '@/lib/responsibility/service';

export async function getShipmentReleaseGate(orderId: string) {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return { error: '请先登录' };
  const db = createServiceRoleClient();
  const [{ data: order }, { data: fin }, { data: milestones }, { data: confirmations }, { data: packing }, { data: batches }, { data: logisticsTasks }] = await Promise.all([
    (db.from('orders') as any).select('delivery_type').eq('id', orderId).maybeSingle(),
    (db.from('order_financials') as any).select('allow_shipment').eq('order_id', orderId).maybeSingle(),
    (db.from('milestones') as any).select('id,step_key,status').eq('order_id', orderId).in('step_key', ['final_qc_check','final_qc_sales_check','inspection_release','booking_done']),
    (db.from('milestone_confirmations') as any).select('party_key,status,milestone_id').eq('order_id', orderId),
    (db.from('packing_lists') as any).select('id').eq('order_id', orderId).limit(1),
    (db.from('shipment_batches') as any).select('id').eq('order_id', orderId).limit(1),
    (db.from('logistics_subtasks') as any).select('id,status').eq('order_id', orderId),
  ]);
  const ms = (milestones || []) as any[];
  const conf = (confirmations || []) as any[];
  const qc = ms.find((m) => ['final_qc_check','final_qc_sales_check','inspection_release'].includes(m.step_key) && isDoneStatus(m.status));
  const booking = ms.find((m) => m.step_key === 'booking_done' && isDoneStatus(m.status));
  const confirmed = (party: string) => conf.some((c) => c.party_key === party && c.status === 'confirmed');
  const isDomestic = order?.delivery_type === 'domestic';
  const domesticLogisticsReady = (logisticsTasks || []).length > 0
    && (logisticsTasks || []).every((task: any) => isDoneStatus(task.status));
  const gate = evaluateShipmentGate({
    business_execution: { passed: confirmed('sales_exec') },
    qc: { passed: !!qc || confirmed('qc'), evidenceId: qc?.id },
    logistics: {
      passed: isDomestic ? domesticLogisticsReady : !!booking || (batches || []).length > 0,
      evidenceId: isDomestic ? logisticsTasks?.[0]?.id : booking?.id,
    },
    finance: { passed: fin?.allow_shipment === true },
    documents: { passed: (packing || []).length > 0, evidenceId: packing?.[0]?.id },
    packing: {
      passed: isDomestic ? (packing || []).length > 0 : (batches || []).length > 0,
      evidenceId: isDomestic ? packing?.[0]?.id : batches?.[0]?.id,
    },
  });
  const responsibilities = await getEffectiveResponsibilities(db as any,orderId);
  const ownerType:Record<string,string> = {
    business_execution:'business_execution_owner',qc:'production_follow_up_owner',logistics:'logistics_owner',
    finance:'finance_owner',documents:'business_execution_owner',packing:'logistics_owner',
  };
  return { data:{...gate,blockers:gate.blockers.map((b)=>{
    const owner=responsibilities.find((r)=>r.type===ownerType[b.key]);
    return {...b,responsibleOwnerId:owner?.userId||null,ownershipSource:owner?.source||'missing'};
  })} };
}
