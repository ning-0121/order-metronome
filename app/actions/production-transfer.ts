'use server';

/**
 * 临时调货(裁片 / 半成品 工厂间临时调拨,2026-07-24)。
 * 场景:A 厂机器坏 / 产能不足,把裁片或半成品临时挪到 B 厂救急,记来源单 / 调出厂 / 调入厂 / 数量 + 归还。
 * 与外发 outsource_jobs 区分:那是「本单发给某厂加工」,这是「两厂间临时挪货,后面要还或并账」。
 * 权限口径与外发一致(EXECUTION:生产/跟单/QC/主管);缺表(迁移未跑)读时返回空、写时给清晰提示,不 brick tab。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const GATE = 'EXECUTION';
const GATE_MSG = '仅生产/跟单/QC/主管可操作临时调货';
// 表/列缺失(迁移未执行)的报错特征
const MISSING = /production_transfers|relation .* does not exist|does not exist|schema cache|could not find/i;
const MIGRATE_HINT = '临时调货表未建,请先在 Supabase 执行 supabase/migrations/20260724_production_transfers.sql';

export async function getProductionTransfers(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('production_transfers') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false });
  if (error) {
    if (MISSING.test(error.message || '')) return { data: [], error: null };   // 迁移未跑 → 空,不 brick tab
    return { data: null, error: error.message };
  }
  return { data, error: null };
}

export async function addProductionTransfer(orderId: string, t: {
  from_factory: string; to_factory: string; item_desc: string; qty: number;
  unit?: string; reason?: string; transfer_date?: string; expected_return_date?: string; notes?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }
  if (!t.from_factory?.trim()) return { error: '调出厂不能为空' };
  if (!t.to_factory?.trim()) return { error: '调入厂不能为空' };
  if (!t.item_desc?.trim()) return { error: '请填写调的是什么(裁片/半成品)' };
  if (!(Number(t.qty) > 0)) return { error: '数量必须大于 0' };

  const { error } = await (supabase.from('production_transfers') as any).insert({
    order_id: orderId, created_by: user.id,
    from_factory: t.from_factory.trim(), to_factory: t.to_factory.trim(),
    item_desc: t.item_desc.trim(), qty: Number(t.qty), unit: t.unit?.trim() || '件',
    reason: t.reason?.trim() || null,
    transfer_date: t.transfer_date || null,
    expected_return_date: t.expected_return_date || null,
    status: 'out',
  });
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateProductionTransfer(id: string, orderId: string, patch: {
  status?: string; actual_return_date?: string; notes?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }

  const clean: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) clean.status = patch.status;
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;
  // 标记「已归还」而没填实际归还日 → 默认今天(采购/生产不用再手点日期)
  if (patch.actual_return_date !== undefined) clean.actual_return_date = patch.actual_return_date || null;
  else if (patch.status === 'returned') clean.actual_return_date = new Date().toISOString().slice(0, 10);

  const { error } = await (supabase.from('production_transfers') as any).update(clean).eq('id', id);
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteProductionTransfer(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, GATE, GATE_MSG); if (err) return { error: err }; }
  const { error } = await (supabase.from('production_transfers') as any).delete().eq('id', id);
  if (error) {
    if (MISSING.test(error.message || '')) return { error: MIGRATE_HINT };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}
