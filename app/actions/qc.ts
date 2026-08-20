'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { requireRoleGroup } from '@/lib/domain/requireRole';
// 常量放纯模块:'use server' 文件只能导出 async function(见 lib/domain/qcInspection.ts 顶部注释)
import { QC_TYPE_LABELS } from '@/lib/domain/qcInspection';
import { insertNotifications } from '@/lib/utils/notifications';

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

export async function updateQcResult(id: string, orderId: string, result: 'pass' | 'fail' | 'conditional' | 'rework') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', QC_WRITE_MSG); if (err) return { error: err }; }

  // 改结论前先读旧值 —— 「fail → pass」是复检合格,要去财务撤销待扣款(见下方)
  const { data: prev } = await (supabase.from('qc_inspections') as any)
    .select('result, inspection_type, qty_fail, notes').eq('id', id).maybeSingle();
  const prevResult = (prev as any)?.result ?? null;

  const { error } = await (supabase.from('qc_inspections') as any)
    .update({ result, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };

  // ── 事件驱动扣款(财务契约 v1,2026-08-03)────────────────────────────────
  // 老板洞察:「工厂有扣款,一定是之前有验货的问题?…这个一定是有事件引发的,
  // 所以我们要看看如何通过事件来锁死工厂扣款这个事情。」
  //
  // 2026-08-02 事故:要扣加工厂几笔费用(合计 ¥1500)圆圆忘了登记。
  // 勾选框只能防「忘了填」,防不住「不知道有」—— 所以把因果链锁上:
  // 验货判不合格 → 财务当场建「待扣款」→ 对账审批时未处理就卡住。
  //
  // ⚠️ 不传 amount:验货这一刻我们并不知道该扣多少。按治理红线,金额与扣不扣
  // 一律由财务在自己 UI 里确认并记真实 auth.uid() —— 节拍器不替财务核销。
  // fire-and-forget:验货结论本身绝不能因为财务不通而失败。
  // 「不合格」与「要求返工」都算工厂担责事件,推同一条链(event_ref 相同,财务侧幂等)。
  // 区别只在 reason —— fail 是这批有问题,rework 是还能救但要返工,追偿的钱不一样。
  const FAULT = new Set(['fail', 'rework']);
  if (FAULT.has(result) && !FAULT.has(String(prevResult))) {
    // 审计 2026-08-19:void→await——serverless 冻结会把未 await 的 promise 整条杀掉,财务事件连 outbox 都进不去(零痕迹);函数内部已吞错,await 不会阻断业务。
    await (async () => {
      try {
        const { createServiceRoleClient } = await import('@/lib/supabase/server');
        const svc = createServiceRoleClient();
        const { data: o } = await (svc.from('orders') as any)
          .select('id, order_no, internal_order_no, factory_name, factory_id').eq('id', orderId).maybeSingle();
        const { emitQcFailed, emitReworkRecorded } = await import('@/lib/integration/supplier-deduction');
        const emit = result === 'rework' ? emitReworkRecorded : emitQcFailed;
        await emit({
          eventRef: `QC-${id}`,                     // 稳定锚点:复检合格时按它撤销
          supplierName: (o as any)?.factory_name ?? null,
          supplierId: (o as any)?.factory_id ?? null,
          orderId,
          orderNo: (o as any)?.order_no ?? null,
          internalOrderNo: (o as any)?.internal_order_no ?? null,
          liableParty: 'factory',                   // 验货不合格/返工 = 工厂担责
          amount: null,                             // 建议值留空,由财务定
          reason: result === 'rework'
            ? `QC 要求返工${(prev as any)?.qty_fail ? `,不合格 ${(prev as any).qty_fail} 件` : ''}(向供应商追偿返工费用)`
            : `验货不合格${(prev as any)?.qty_fail ? `,不合格 ${(prev as any).qty_fail} 件` : ''}`,
          detail: {
            inspection_id: id,
            inspection_type: (prev as any)?.inspection_type ?? null,
            defect_qty: (prev as any)?.qty_fail ?? null,
            notes: (prev as any)?.notes ?? null,
          },
        });
      } catch (e: any) { console.error('[QC] qc.failed 推送失败(不阻断):', e?.message); }
    })();
  }

  // 判返工 → **自动派一条复检任务**(CEO 2026-08-04:「返工后去重新验货」)。
  // 不自动建的话,「返工完了谁去复检」全靠人记得 —— 这正是本轮要根治的那类漏洞。
  // 复检沿用同一个 QC(谁判的返工谁复检,口径一致),rework_of 指回本次,便于追「返了几次」。
  if (result === 'rework' && prevResult !== 'rework') {
    try {
      const svc2 = (await import('@/lib/supabase/server')).createServiceRoleClient();
      // 已经有针对本次的复检就不重复建(改判来回切时防刷)
      const { data: exist } = await (svc2.from('qc_inspections') as any)
        .select('id').eq('rework_of', id).limit(1);
      if (!exist?.length) {
        const src: any = prev || {};
        await (svc2.from('qc_inspections') as any).insert({
          order_id: orderId,
          inspection_type: 're-inspection',
          result: 'pending',
          task_status: 'assigned',
          rework_of: id,
          assigned_to: src.assigned_to ?? null,
          assigned_by: user.id,
          assigned_at: new Date().toISOString(),
          assignment_note: `返工后复检(源自第 ${String(id).slice(0, 8)} 次检验的返工要求)`,
        });
      }
    } catch (e: any) { console.error('[QC] 复检任务自动创建失败(不阻断):', e?.message); }
  }

  // 复检合格 / 改判放行 → 撤销之前那条待扣款(财务侧只撤 pending;已扣的钱要人工红冲)
  if (FAULT.has(String(prevResult)) && !FAULT.has(result)) {
    // 审计 2026-08-19:void→await——serverless 冻结会把未 await 的 promise 整条杀掉,财务事件连 outbox 都进不去(零痕迹);函数内部已吞错,await 不会阻断业务。
    await (async () => {
      try {
        const { emitDeductionCancelled } = await import('@/lib/integration/supplier-deduction');
        await emitDeductionCancelled(`QC-${id}`, result === 'pass' ? '复检合格' : '改判为有条件接受');
      } catch (e: any) { console.error('[QC] deduction.cancelled 推送失败(不阻断):', e?.message); }
    })();
  }

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

/* ────────────────────────────────────────────────────────────────────────────
 * 加查 / 上线审查:可委派的检验任务(2026-07-30)
 *
 * QC 独立成角色后要接「生产主管委派的加查」。复用 qc_inspections 这张既有台账
 * (一单可多条、milestone_id 可空、结论列齐全),只加了委派列 —— 不另建对象,
 * 免得「一次检验」出现第二个真相源(出运闸已在读这张表)。
 *
 * 列的所有权切分:主管只写委派列,QC 只写结论列。主管委派加查,但不替 QC 下结论。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 可委派检验的人:生产主管 / admin(与 CAN_REASSIGN_OWNER 的"派活"语义一致) */
const CAN_ASSIGN_QC = ['admin', 'production_manager'];

async function qcRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (p as any)?.roles?.length > 0 ? (p as any).roles : [(p as any)?.role].filter(Boolean);
}

/** 生产主管委派一次检验(加查/上线审查/复检…)给某个 QC。 */
export async function assignQcInspection(input: {
  orderId: string;
  assignedTo: string;
  inspectionType?: string;
  dueDate?: string | null;
  note?: string | null;
}): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await qcRoles(supabase, user.id);
  if (!roles.some((r) => CAN_ASSIGN_QC.includes(r))) return { error: '仅生产主管/管理员可委派检验任务' };

  const type = input.inspectionType || 'extra';
  if (!Object.prototype.hasOwnProperty.call(QC_TYPE_LABELS, type)) return { error: '检验类型不合法' };
  if (!input.assignedTo) return { error: '请选择要委派的 QC' };

  // 被派的人必须真是 QC —— 否则「委派加查」会变成随便派给谁
  const targetRoles = await qcRoles(supabase, input.assignedTo);
  if (!targetRoles.some((r) => ['qc', 'quality'].includes(String(r).toLowerCase()))) {
    return { error: '只能委派给 QC 角色的同事' };
  }

  const now = new Date().toISOString();
  const { data, error } = await (supabase.from('qc_inspections') as any).insert({
    order_id: input.orderId,
    inspection_type: type,
    assigned_to: input.assignedTo,
    assigned_by: user.id,
    assigned_at: now,
    due_date: input.dueDate || null,
    assignment_note: input.note || null,
    task_status: 'assigned',
    result: 'pending',
    // 结论列留空,等 QC 做完自己填(主管不替 QC 下结论)
    qty_inspected: 0, qty_pass: 0, qty_fail: 0,
  }).select('id').single();
  if (error) {
    if (/assigned_to|task_status|column .* does not exist|inspection_type_check/i.test(error.message || '')) {
      return { error: '「委派检验」需先执行迁移 20260730_qc_inspection_assignment.sql。' };
    }
    return { error: error.message };
  }

  // 通知被派的 QC(fire-and-forget,失败不阻断委派)
  try {
    const { data: ord } = await (supabase.from('orders') as any)
      .select('order_no, internal_order_no').eq('id', input.orderId).maybeSingle();
    const no = (ord as any)?.internal_order_no || (ord as any)?.order_no || '订单';
    await insertNotifications({
      user_id: input.assignedTo,
      type: 'qc_task_assigned',
      title: `新的${QC_TYPE_LABELS[type]}任务 · ${no}`,
      message: `生产主管委派了一次${QC_TYPE_LABELS[type]}${input.dueDate ? `,要求 ${input.dueDate} 前完成` : ''}。${input.note || ''}`,
      link: `/production/order/${input.orderId}`,
    });
  } catch { /* 通知失败不影响委派 */ }

  revalidatePath(`/production/order/${input.orderId}`);
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, id: (data as any)?.id };
}

/** QC 回填检验结论并结单(只写结论列,不碰委派列)。 */
export async function completeQcInspection(input: {
  id: string;
  orderId: string;
  qtyInspected: number;
  qtyPass: number;
  qtyFail: number;
  result: 'pass' | 'fail' | 'conditional';
  notes?: string | null;
  aqlLevel?: string | null;
}): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', QC_WRITE_MSG); if (err) return { error: err }; }
  if (!input.qtyInspected || input.qtyInspected <= 0) return { error: '抽检数量必须大于 0' };
  if (input.qtyPass + input.qtyFail > input.qtyInspected) return { error: '合格+不合格 不能超过抽检数量' };

  const { error } = await (supabase.from('qc_inspections') as any).update({
    qty_inspected: input.qtyInspected,
    qty_pass: input.qtyPass || 0,
    qty_fail: input.qtyFail || 0,
    result: input.result,
    notes: input.notes || null,
    aql_level: input.aqlLevel || 'II',
    inspector_id: user.id,          // 谁做的检验,以结单人为准
    inspection_date: new Date().toISOString().slice(0, 10),
    task_status: 'done',
    updated_at: new Date().toISOString(),
  }).eq('id', input.id);
  if (error) return { error: error.message };

  revalidatePath(`/production/order/${input.orderId}`);
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true };
}

/** 取消一条委派(派错了/不用查了)。只有派单人或 admin 能取消。 */
export async function cancelQcInspection(id: string, orderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await qcRoles(supabase, user.id);
  const { data: row } = await (supabase.from('qc_inspections') as any)
    .select('assigned_by, task_status').eq('id', id).maybeSingle();
  if (!row) return { error: '记录不存在' };
  if (String((row as any).task_status) === 'done') return { error: '已出结论的检验不能取消(如需作废请删除记录)' };
  if (!roles.includes('admin') && (row as any).assigned_by !== user.id) {
    return { error: '只有委派人本人或管理员可以取消' };
  }
  const { error } = await (supabase.from('qc_inspections') as any)
    .update({ task_status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/production/order/${orderId}`);
  return { ok: true };
}

/** 可被委派的 QC 名单(给主管的下拉用)。 */
export async function listQcCandidates(): Promise<{ data?: Array<{ user_id: string; name: string }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('profiles') as any)
    .select('user_id, name, email, role, roles').eq('is_active', true);
  if (error) return { error: error.message };
  const list = ((data || []) as any[])
    .filter((p) => {
      const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
      return rs.some((r) => ['qc', 'quality'].includes(String(r).toLowerCase()));
    })
    .map((p) => ({ user_id: p.user_id, name: p.name || p.email?.split('@')[0] || '(未命名)' }));
  return { data: list };
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
