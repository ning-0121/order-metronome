'use server';

/**
 * 订单进度校准(2026-07-09 用户拍板):真实订单之前没人在系统里推进 → 早期节点全逾期 → 业务端一片"风险"。
 * 由 admin / 生产主管 指定"这单实际到了哪个节点",系统把该节点之前的里程碑全部标【已完成】(逾期风险随之消失),
 * 该节点设【进行中】,之后节点保持不动(按各自计划/新节点执行)。复用"进行中订单导入"同一套推进逻辑。
 * 只推进节点,不改订单锚点/出厂日;完成后触发风险重算,风险卡即刷新。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/** 批量进度校准页数据:活单(未完成/取消/归档)+ 各单里程碑步骤 + 自动推测的当前节点(首个未完成)。仅 admin/生产主管。 */
export async function listOrdersForCalibration(): Promise<{
  data?: Array<{
    order_id: string; order_no: string | null; customer_name: string | null; factory_date: string | null;
    lifecycle_status: string | null; done_count: number; total: number; current_hint: string;
    steps: Array<{ step_key: string; name: string; status: string; sequence: number }>;
  }>;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.includes('admin') && !roles.includes('production_manager')) return { error: '仅管理员或生产主管可批量校准' };

  const HIDDEN = ['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档'];
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_date, lifecycle_status')
    .not('lifecycle_status', 'in', `(${HIDDEN.map((s) => `"${s}"`).join(',')})`)
    .order('factory_date', { ascending: true }).limit(300);
  const list = (orders || []) as any[];
  if (list.length === 0) return { data: [] };
  const orderIds = list.map((o) => o.id);

  // ⚠ 关键(2026-07-09 修):默认 1000 行上限 + 全局按 sequence 排序 → 会把各单靠后的节点(尾查/工厂完成/
  //   出运/收款)整批截断,下拉只到 包装方式确认 附近。显式高 limit + 按 order_id 再 sequence 排,取全每单节点。
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('order_id, step_key, name, status, sequence_number').in('order_id', orderIds)
    .order('order_id', { ascending: true }).order('sequence_number', { ascending: true })
    .limit(20000);
  const byOrder = new Map<string, any[]>();
  for (const m of (ms || [])) { const a = byOrder.get((m as any).order_id) || []; a.push(m); byOrder.set((m as any).order_id, a); }

  const isDone = (s: any) => ['done', '已完成', 'completed'].includes(String(s || ''));
  const out = list.map((o) => {
    const steps = (byOrder.get(o.id) || []).map((m: any) => ({ step_key: m.step_key, name: m.name, status: m.status, sequence: Number(m.sequence_number) }))
      .sort((a: any, b: any) => a.sequence - b.sequence);
    const doneCount = steps.filter((s) => isDone(s.status)).length;
    const firstUndone = steps.find((s) => !isDone(s.status));
    return {
      order_id: o.id, order_no: o.order_no, customer_name: o.customer_name, factory_date: o.factory_date,
      lifecycle_status: o.lifecycle_status, done_count: doneCount, total: steps.length,
      current_hint: firstUndone?.step_key || (steps[steps.length - 1]?.step_key ?? ''), steps,
    };
  }).filter((o) => o.steps.length > 0);
  return { data: out };
}

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
