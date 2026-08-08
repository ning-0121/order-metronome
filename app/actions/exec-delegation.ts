'use server';

/**
 * Executive OS V1 · Delegation(S3 分发 + S4 提交/核对)。
 * executive_delegations = 唯一真相源。所有写 = service-role Business Command
 * + safeCriticalMutation(断言+回读)+ writeAuditEvent。Agent 不自主写终态。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { safeMutation, safeCriticalMutation } from '@/lib/db/safe-mutation';
import { writeAuditEvent } from '@/lib/audit/write-audit-event';
import { revalidatePath } from 'next/cache';

async function me() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = p?.roles?.length ? p.roles : [p?.role].filter(Boolean);
  return { userId: user.id, roles, isAdmin: roles.includes('admin') };
}

/** owner_hint(名字)→ user_id 消歧。返回唯一命中/歧义/无匹配。 */
export async function resolveOwner(svc: any, hint: string): Promise<{ userId?: string; status: 'resolved' | 'ambiguous' | 'none' }> {
  if (!hint?.trim()) return { status: 'none' };
  const { data } = await (svc.from('profiles') as any).select('user_id, name').ilike('name', `%${hint.trim()}%`).limit(5);
  const hits = (data || []) as any[];
  if (hits.length === 1) return { userId: hits[0].user_id, status: 'resolved' };
  return { status: hits.length > 1 ? 'ambiguous' : 'none' };
}

export interface ConfirmInput {
  captureId: string;
  captureItemId: string;
  title: string;
  instruction: string;
  ownerUserId: string;              // 确认卡上 CEO 已选定(消歧后的真实 user)
  deadline?: string | null;        // ISO,确认卡固化前已显示绝对时间(修正④)
  deadlineTz?: string;
  deadlineSourceText?: string | null;
  deadlineConfidence?: number | null;
  acceptanceCriteria?: string | null;
  constraints?: any;
  counterpartyName?: string | null; // Gregory(可未入库)
  counterpartyId?: string | null;
  why?: string | null;
  priority?: number;
}

/** S3:CEO 确认 → 建委托(真相源)。deadline 必须已是绝对时间;owner 必须真实存在。 */
export async function confirmDelegation(input: ConfirmInput): Promise<{ delegationId?: string; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  if (!auth.isAdmin) return { error: '仅管理员(CEO)可确认委托' };
  if (!input.title?.trim() || !input.instruction?.trim()) return { error: '标题与指令不能为空' };
  if (!input.ownerUserId) return { error: '必须指定负责人(未匹配到员工时不能确认)' };

  const svc = createServiceRoleClient();
  // owner 必须真实存在(防打错名/前端传脏)
  const { data: ownerRow } = await (svc.from('profiles') as any).select('user_id, name').eq('user_id', input.ownerUserId).maybeSingle();
  if (!ownerRow) return { error: '负责人不存在,请重新选择' };

  const entityStatus = input.counterpartyName
    ? (input.counterpartyId ? 'resolved' : 'tentative')   // 修正③:未入库=tentative,不建客户
    : 'none';

  const res = await safeMutation<{ id: string }>({
    client: svc, table: 'executive_delegations', operation: 'insert', expectedRows: 1,
    payload: {
      source_capture_id: input.captureId, source_capture_item_id: input.captureItemId,
      title: input.title.trim(), instruction: input.instruction.trim(), why: input.why || null,
      owner_user_id: input.ownerUserId,
      deadline: input.deadline || null, deadline_tz: input.deadlineTz || 'Asia/Shanghai',
      deadline_source_text: input.deadlineSourceText || null, deadline_confidence: input.deadlineConfidence ?? null,
      priority: input.priority || 3,
      acceptance_criteria: input.acceptanceCriteria || null, constraints: input.constraints || null,
      counterparty_name: input.counterpartyName || null, counterparty_id: input.counterpartyId || null,
      entity_resolution_status: entityStatus,
      delegation_status: 'assigned',
      confirmed_by: auth.userId, confirmed_at: new Date().toISOString(),
      created_by: auth.userId,
    },
  });
  if (!res.ok) return { error: `委托创建失败(${res.status}):${res.error}` };
  const delegationId = res.data![0].id;

  // 回填 capture_item + 推进 capture 状态
  await safeMutation({ client: svc, table: 'executive_capture_items', operation: 'update',
    payload: { confirmation_status: 'confirmed', confirmed_by: auth.userId, confirmed_at: new Date().toISOString(), spawned_delegation_id: delegationId },
    predicate: { id: input.captureItemId }, expectedRows: 'any' });
  await (svc.from('executive_captures') as any).update({ processing_status: 'confirmed' }).eq('id', input.captureId);

  // A2 审计:三层显式溯源(修正①,不用 decision_id)
  await writeAuditEvent({
    eventType: 'delegation_confirmed', level: 'A2', riskLevel: 'delivery',
    actor: { actorType: 'user', actorId: auth.userId },
    entity: { entityType: 'order', entityId: delegationId, orderId: null } as any,
    commandName: 'confirmDelegation',
    reason: `CEO 委托:${input.title.trim()} → ${ownerRow.name}`,
    metadata: { source_capture_id: input.captureId, source_capture_item_id: input.captureItemId, owner: input.ownerUserId },
  });

  // 投影:通知员工(TS1 不建 daily_tasks 投影,员工端直读 delegations —— 修正⑥)
  try {
    const { insertNotifications } = await import('@/lib/utils/notifications');
    await insertNotifications({
      user_id: input.ownerUserId, type: 'exec_delegation',
      title: `📌 CEO 交代:${input.title.trim()}`,
      message: `${input.instruction.trim()}${input.deadline ? `\n截止:${input.deadline}` : ''}${input.acceptanceCriteria ? `\n验收:${input.acceptanceCriteria}` : ''}`,
    });
  } catch (e: any) { console.error('[confirmDelegation] 通知失败(不阻断):', e?.message); }

  revalidatePath('/ceo');
  return { delegationId };
}

/** S4a:员工提交(不信自报 —— 只记提交,验证另走)。 */
export async function submitDelegation(
  id: string, payload: { summary: string; linkedOrderId?: string | null; artifactRefs?: any },
): Promise<{ ok?: boolean; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const svc = createServiceRoleClient();
  const { data: d } = await (svc.from('executive_delegations') as any).select('owner_user_id, delegation_status').eq('id', id).maybeSingle();
  if (!d) return { error: '委托不存在' };
  if (d.owner_user_id !== auth.userId && !auth.isAdmin) return { error: '只有负责人可提交' };

  const res = await safeCriticalMutation({
    client: svc, table: 'executive_delegations', operation: 'update',
    payload: {
      delegation_status: 'submitted', submitted_at: new Date().toISOString(),
      submission_summary: payload.summary || null, submission_artifact_refs: payload.artifactRefs || null,
      linked_order_id: payload.linkedOrderId || null, verification_status: 'pending', updated_at: new Date().toISOString(),
    },
    predicate: { id, delegation_status: d.delegation_status },   // CAS
    auditOrderId: payload.linkedOrderId || null,
    ctx: { actor: auth.userId, reason: '员工提交委托成果', riskLevel: 'delivery', decisionId: id,
           verifyFields: { delegation_status: 'submitted' } },
  });
  if (!res.ok) return { error: `提交未生效(${res.status}):${res.error}` };
  revalidatePath('/ceo');
  return { ok: true };
}

/**
 * S4b:核对 —— **重读最新 order_financials.margin_pct,不信员工自报**(修正⑤)。
 * 缺失/无法关联/无法确认 → need_info,绝不 verified。
 */
export async function verifyDelegation(id: string): Promise<{ status?: string; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const svc = createServiceRoleClient();
  const { data: d } = await (svc.from('executive_delegations') as any)
    .select('*').eq('id', id).maybeSingle();
  if (!d) return { error: '委托不存在' };
  if (d.delegation_status !== 'submitted') return { error: `当前状态(${d.delegation_status})不可核对,仅"已提交"可核对` };

  // 进入 verifying
  await (svc.from('executive_delegations') as any).update({ delegation_status: 'verifying' }).eq('id', id);

  // 解析约束:找 min_margin
  const cons = Array.isArray(d.constraints) ? d.constraints : [];
  const marginRule = cons.find((c: any) => c?.type === 'min_margin');
  const threshold = marginRule ? Number(marginRule.value) : null;

  let verStatus: 'pass' | 'fail' | 'need_info' = 'pass';
  let reason = '';
  let result: any = {};

  if (threshold != null) {
    // 重读最新利润(权威源,不信提交里的自报)
    if (!d.linked_order_id) {
      verStatus = 'need_info'; reason = '未关联订单,无法读取利润率 —— 请员工在提交时绑定订单';
    } else {
      const { data: fin } = await (svc.from('order_financials') as any)
        .select('margin_pct').eq('order_id', d.linked_order_id).maybeSingle();
      const margin = (fin as any)?.margin_pct;
      if (margin == null) {
        verStatus = 'need_info'; reason = `订单 ${d.linked_order_id} 无利润率数据,无法核对`;
      } else {
        result = { margin_pct: Number(margin), threshold, source: 'order_financials' };
        if (Number(margin) >= threshold) { verStatus = 'pass'; reason = `利润率 ${margin}% ≥ ${threshold}%`; }
        else { verStatus = 'fail'; reason = `利润率 ${margin}% < ${threshold}%,不得进入可发送状态`; }
      }
    }
  } else {
    // 无量化约束 → 需人工核(TS1 不自动 verified)
    verStatus = 'need_info'; reason = '无量化验收标准,需人工确认';
  }

  const nextStatus = verStatus === 'pass' ? 'verified' : verStatus === 'fail' ? 'rework' : 'submitted';
  const res = await safeCriticalMutation({
    client: svc, table: 'executive_delegations', operation: 'update',
    payload: {
      delegation_status: nextStatus, verification_status: verStatus,
      verification_result: result, verification_reason: reason,
      verified_by: null, verified_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    predicate: { id, delegation_status: 'verifying' },
    auditOrderId: d.linked_order_id || null,
    ctx: { actor: 'system', reason: `委托核对:${reason}`, riskLevel: 'delivery', decisionId: id,
           verifyFields: { delegation_status: nextStatus } },
  });
  if (!res.ok) return { error: `核对结果写入未生效(${res.status}):${res.error}` };

  // 通知:pass→CEO;fail→员工返工
  try {
    const { insertNotifications } = await import('@/lib/utils/notifications');
    if (verStatus === 'pass') {
      await insertNotifications({ user_id: d.created_by, type: 'exec_delegation',
        title: `✅ 委托已完成并验证:${d.title}`, message: reason });
    } else if (verStatus === 'fail') {
      await insertNotifications({ user_id: d.owner_user_id, type: 'exec_delegation',
        title: `↩️ 委托需返工:${d.title}`, message: reason });
    }
  } catch { /* 通知失败不阻断 */ }

  revalidatePath('/ceo');
  return { status: nextStatus };
}

/** 员工端:直读派给自己的委托(TS1 不走 daily_tasks 投影) */
export async function getMyDelegations() {
  const auth = await me();
  if ('error' in auth) return { error: auth.error, data: [] };
  const supabase = await createClient();   // 走 RLS(owner 可见)
  const { data } = await (supabase.from('executive_delegations') as any)
    .select('id, title, instruction, deadline, acceptance_criteria, delegation_status, verification_reason, linked_order_id')
    .eq('owner_user_id', auth.userId).order('created_at', { ascending: false }).limit(50);
  return { data: data || [] };
}

/** CEO 端:你委托的 / 已完成验证 */
export async function getCeoDelegations() {
  const auth = await me();
  if ('error' in auth) return { error: auth.error, data: [] };
  const supabase = await createClient();
  const { data } = await (supabase.from('executive_delegations') as any)
    .select('id, title, owner_user_id, deadline, delegation_status, verification_status, verification_reason, source_capture_id, created_at')
    .eq('created_by', auth.userId).order('created_at', { ascending: false }).limit(100);
  return { data: data || [] };
}

/** 反查链:从委托回到 CEO 原话 */
export async function traceDelegation(id: string) {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  const svc = createServiceRoleClient();
  const { data: d } = await (svc.from('executive_delegations') as any).select('*').eq('id', id).maybeSingle();
  if (!d) return { error: '委托不存在' };
  const { data: cap } = await (svc.from('executive_captures') as any).select('raw_text, captured_at, actor_user_id').eq('id', d.source_capture_id).maybeSingle();
  const { data: item } = await (svc.from('executive_capture_items') as any).select('item_type, structured_payload, confidence').eq('id', d.source_capture_item_id).maybeSingle();
  return { data: { delegation: d, capture: cap, item } };
}

/**
 * 把 parseCapture 的草案项转成确认卡视图:owner 消歧 + deadline 尽力解析。
 * proposed_delegation 才成卡;constraint 合并进对应卡的 acceptance/constraints。
 */
export async function prepareDelegationDrafts(captureId: string): Promise<{ drafts?: any[]; error?: string }> {
  const auth = await me();
  if ('error' in auth) return { error: auth.error };
  if (!auth.isAdmin) return { error: '仅管理员(CEO)' };
  const svc = createServiceRoleClient();
  const { data: items } = await (svc.from('executive_capture_items') as any)
    .select('id, item_type, structured_payload, confidence').eq('capture_id', captureId).eq('confirmation_status', 'pending');
  const list = (items || []) as any[];

  // constraint 项(如 min_margin)聚合成一条 acceptance + constraints,附到每个委托卡
  const constraints = list.filter((i) => i.item_type === 'constraint').map((i) => {
    const p = i.structured_payload || {};
    return { type: p.constraint_type || 'rule', value: p.constraint_value ?? null, restrict: p.restrict || null, text: p.text || '' };
  });
  const acceptanceText = constraints.map((c) => c.type === 'min_margin' ? `利润率 ≥ ${c.value}%${c.restrict ? `(否则不得进入可${c.restrict === 'send' ? '发送' : c.restrict}状态)` : ''}` : (c.text || `${c.type}`)).join(';') || null;

  const drafts = [];
  for (const it of list.filter((i) => i.item_type === 'proposed_delegation')) {
    const p = it.structured_payload || {};
    const owner = await resolveOwner(svc, p.owner_hint || '');
    let ownerResolved = null, ownerCandidates: any[] = [];
    if (owner.status === 'resolved') {
      const { data: o } = await (svc.from('profiles') as any).select('user_id, name').eq('user_id', owner.userId).maybeSingle();
      ownerResolved = o;
    } else if (owner.status === 'ambiguous') {
      const { data: cands } = await (svc.from('profiles') as any).select('user_id, name').ilike('name', `%${(p.owner_hint || '').trim()}%`).limit(5);
      ownerCandidates = cands || [];
    }
    // 对手方消歧(只查,不建)
    let counterpartyResolved = false;
    if (p.person || p.customer_hint) {
      const q = (p.customer_hint || p.person).trim();
      const { data: c } = await (svc.from('customers') as any).select('id').ilike('name', `%${q}%`).limit(1);
      counterpartyResolved = !!(c && c.length);
    }
    drafts.push({
      id: it.id, captureId,
      title: p.action ? String(p.action).slice(0, 60) : '委托事项',
      instruction: p.action || it.structured_payload?.text || '',
      ownerHint: p.owner_hint || null, ownerResolved, ownerCandidates,
      deadlineText: p.deadline_text || null,
      deadlineAbsolute: null,   // TS1:交由 CEO 在确认卡上明确设定(修正④,不自动猜)
      deadlineTz: 'Asia/Shanghai', deadlineConfidence: it.confidence ?? null,
      acceptanceCriteria: acceptanceText,
      constraints: constraints.length ? constraints : null,
      counterpartyName: p.person || p.customer_hint || null,
      counterpartyResolved,
    });
  }
  return { drafts };
}
