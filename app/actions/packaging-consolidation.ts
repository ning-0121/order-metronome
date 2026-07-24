'use server';

/**
 * 包装归集(指定包装厂 + 逐批到货进度,2026-07-24)。
 * 一张单裁片/车缝分散在多厂,成品陆续汇集到一个「包装归集厂」做最终包装;
 * 指定包装厂 + 逐批登记各厂到货,系统算「已归集 vs 订单总量」,齐了才开包装。
 * 权限口径与外发一致(EXECUTION);缺表(迁移未跑)读时返回空、写时给清晰提示,不 brick tab。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const GATE = 'EXECUTION';
const GATE_MSG = '仅生产/跟单/QC/主管可操作包装归集';
const MISSING = /packaging_consolidation|packaging_gather_records|relation .* does not exist|does not exist|schema cache|could not find/i;
const MIGRATE_HINT = '包装归集表未建,请先在 Supabase 执行 supabase/migrations/20260724_packaging_consolidation.sql';

export async function getPackagingConsolidation(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as string };
  const [{ data: header, error: hErr }, { data: records, error: rErr }, { data: ord }] = await Promise.all([
    (supabase.from('packaging_consolidation') as any).select('*').eq('order_id', orderId).maybeSingle(),
    (supabase.from('packaging_gather_records') as any).select('*').eq('order_id', orderId).order('created_at', { ascending: false }),
    (supabase.from('orders') as any).select('quantity').eq('id', orderId).maybeSingle(),
  ]);
  if (hErr && MISSING.test(hErr.message || '')) return { header: null, records: [], gathered: 0, orderQty: (ord as any)?.quantity ?? null };
  if (hErr) return { error: hErr.message };
  if (rErr && !MISSING.test(rErr.message || '')) return { error: rErr.message };
  const recs = (records || []) as any[];
  const gathered = recs.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  return { header: header || null, records: recs, gathered, orderQty: (ord as any)?.quantity ?? null };
}

export async function setPackagingConsolidation(orderId: string, h: { packing_factory?: string; target_qty?: number | null; notes?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }

  const payload: Record<string, any> = {
    order_id: orderId,
    packing_factory: h.packing_factory?.trim() || null,
    target_qty: h.target_qty != null && !Number.isNaN(Number(h.target_qty)) ? Number(h.target_qty) : null,
    notes: h.notes?.trim() || null,
    created_by: user.id,
    updated_at: new Date().toISOString(),
  };
  const { error } = await (supabase.from('packaging_consolidation') as any).upsert(payload, { onConflict: 'order_id' });
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function addGatherRecord(orderId: string, r: {
  from_factory: string; item_desc?: string; qty: number; unit?: string; arrived_date?: string; notes?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }
  if (!r.from_factory?.trim()) return { error: '来源厂不能为空' };
  if (!(Number(r.qty) > 0)) return { error: '到货数量必须大于 0' };

  const { error } = await (supabase.from('packaging_gather_records') as any).insert({
    order_id: orderId, created_by: user.id,
    from_factory: r.from_factory.trim(), item_desc: r.item_desc?.trim() || null,
    qty: Number(r.qty), unit: r.unit?.trim() || '件',
    arrived_date: r.arrived_date || null, notes: r.notes?.trim() || null,
  });
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteGatherRecord(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }
  const { error } = await (supabase.from('packaging_gather_records') as any).delete().eq('id', id);
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}
