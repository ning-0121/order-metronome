'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { requireRoleGroup } from '@/lib/domain/requireRole';

// QC 抽检是放行依据 → 写入(增/改判/删)限执行组(生产/QC/跟单/生产主管/admin),不再任意登录用户可篡改
const QC_WRITE_MSG = '仅生产/QC/跟单/管理员可录入或修改质检结果';

export async function getQcInspections(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('qc_inspections') as any)
    .select('*').eq('order_id', orderId).order('inspection_date', { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addQcInspection(orderId: string, rec: {
  inspection_type: string; qty_inspected: number;
  qty_pass: number; qty_fail: number; aql_level?: string; notes?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', QC_WRITE_MSG); if (err) return { error: err }; }
  if (!rec.qty_inspected || rec.qty_inspected <= 0) return { error: '抽检数量必须大于0' };

  const { error } = await (supabase.from('qc_inspections') as any).insert({
    order_id: orderId, inspector_id: user.id,
    inspection_type: rec.inspection_type || 'mid',
    qty_inspected: rec.qty_inspected,
    qty_pass: rec.qty_pass || 0,
    qty_fail: rec.qty_fail || 0,
    aql_level: rec.aql_level || 'II',
    notes: rec.notes || null,
    result: 'pending',
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateQcResult(id: string, orderId: string, result: 'pass' | 'fail' | 'conditional') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', QC_WRITE_MSG); if (err) return { error: err }; }

  const { error } = await (supabase.from('qc_inspections') as any)
    .update({ result, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };

  // 部门考核 hook(2026-07-25 CEO B 方案):QC 判 pass → 落一条生产部(QC)考核记录,目标日取尾查节点 due。
  if (result === 'pass') {
    try {
      const { recordDeptAssessment, milestoneDueDate } = await import('./dept-assessment');
      const { createServiceRoleClient } = await import('@/lib/supabase/server');
      const target = await milestoneDueDate(createServiceRoleClient(), orderId, ['final_qc_sales_check', 'final_qc_check', 'inspection_release']);
      await recordDeptAssessment(orderId, 'production', { task_key: 'qc_passed', task_label: '尾查合格', user_id: user.id, target_date: target });
    } catch { /* 考核旁路,不阻断 QC */ }
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteQcInspection(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', QC_WRITE_MSG); if (err) return { error: err }; }

  // 2026-07-20 修:qc_inspections 无 DELETE 的 RLS 策略 → user-session 删静默删 0 行、无 error(“无法删除”)。
  // 门禁已在上面用 user-session 校验;实际删除走 service-role 绕 RLS,并用 .select() 确认真删了行。
  const svc = createServiceRoleClient();
  const { data: deleted, error } = await (svc.from('qc_inspections') as any).delete().eq('id', id).select('id');
  if (error) return { error: error.message };
  if (!deleted || deleted.length === 0) return { error: '删除失败:记录不存在' };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
