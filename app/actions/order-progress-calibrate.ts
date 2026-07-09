'use server';

/**
 * 订单进度校准(2026-07-09 用户拍板):真实订单之前没人在系统里推进 → 早期节点全逾期 → 业务端一片"风险"。
 * 由 admin / 生产主管 指定"这单实际到了哪个节点",系统把该节点之前的里程碑全部标【已完成】(逾期风险随之消失),
 * 该节点设【进行中】,之后节点保持不动(按各自计划/新节点执行)。复用"进行中订单导入"同一套推进逻辑。
 * 只推进节点,不改订单锚点/出厂日;完成后触发风险重算,风险卡即刷新。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function calibrateOrderStage(
  orderId: string,
  currentStepKey: string,
): Promise<{ ok?: boolean; done?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');
  const isPM = roles.includes('production_manager');
  if (!isAdmin && !isPM) return { error: '仅管理员或生产主管可校准订单进度' };

  // 取该订单里程碑(按序);不依赖固定模板 → V1/V2 都适用
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, step_key, name, sequence_number, status, due_at')
    .eq('order_id', orderId)
    .order('sequence_number', { ascending: true });
  const list = (milestones || []) as any[];
  if (list.length === 0) return { error: '该订单没有里程碑' };

  const current = list.find((m) => m.step_key === currentStepKey);
  if (!current) return { error: '选择的节点不在该订单里程碑中' };
  const currentSeq = Number(current.sequence_number);

  const nowIso = new Date().toISOString();
  let done = 0;
  for (const ms of list) {
    const seq = Number(ms.sequence_number);
    let updates: Record<string, any> | null = null;
    if (seq < currentSeq) {
      // 之前节点 → 标已完成(逾期风险消失);实际完成时间取原计划日,无则取现在
      if (!['done', '已完成', 'completed'].includes(String(ms.status || ''))) {
        updates = { status: 'done', actual_at: ms.due_at || nowIso };
      }
    } else if (seq === currentSeq) {
      if (!['done', '已完成', 'completed'].includes(String(ms.status || ''))) {
        updates = { status: 'in_progress' };
      }
    }
    if (!updates) continue;
    // 优先 admin_update_milestone RPC(绕 RLS 稳),失败兜底直接 update
    let rpcOk = false;
    try { const { error } = await (supabase.rpc as any)('admin_update_milestone', { _milestone_id: ms.id, _updates: updates }); rpcOk = !error; } catch { rpcOk = false; }
    if (!rpcOk) { await (supabase.from('milestones') as any).update(updates).eq('id', ms.id); }
    if (updates.status === 'done') done++;
  }

  // 风险重算(否则风险卡不刷新)——统一入口 fireRuntimeRecompute
  try {
    const { fireRuntimeRecompute } = await import('@/lib/repositories/milestonesRepo');
    fireRuntimeRecompute(orderId, { type: 'progress_calibrated', current_step: currentStepKey });
  } catch (e: any) { console.warn('[calibrateOrderStage] 风险重算触发失败(不阻断):', e?.message); }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return { ok: true, done };
}
