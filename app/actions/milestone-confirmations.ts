'use server';

/**
 * 节点体系 V2 · P1b —— 节点多方确认(2026-07-03)
 * 设计:docs/Designs/Milestone-V2-Departments-Redesign.md §二
 *
 * 「节点完成 = 所有要求方确认完毕」:
 *  - 行懒建:首次查看/确认时按 confirmationParties 配置补齐 pending 行(老数据/漏建自愈);
 *  - confirmMilestoneParty:角色把关(须属于该方角色组;admin 可代确认,日志留痕);幂等;
 *  - 全部确认齐:节点免证据 → 自动完成(留痕+触发交付置信度重算);
 *    要证据 → 返回提示,负责人照常上传凭证后点完成(markMilestoneDone 的门禁会放行)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  requiredPartiesFor, canConfirmParty, pendingParties,
} from '@/lib/domain/confirmationParties';
import { notifyUsersByRole } from '@/lib/utils/notifications';

/**
 * 通知待确认方 —— 多方节点「其他方收不到确认请求」的修复(2026-07-10 用户拍板)。
 * 站内通知按角色扇出(service-role,能读全 profiles + 为他人建 notifications);失败不阻断主链路。
 */
async function notifyPendingParties(
  milestone: { order_id: string; step_key: string; name?: string | null },
  parties: Array<{ label: string; roles: string[] }>,
) {
  if (parties.length === 0) return;
  try {
    const svc = createServiceRoleClient();
    const nodeName = milestone.name || milestone.step_key;
    for (const p of parties) {
      await notifyUsersByRole(svc, p.roles, {
        type: 'milestone_confirmation_pending',
        title: `待你确认:${nodeName}`,
        message: `有订单需要你以「${p.label}」身份确认「${nodeName}」节点。请打开该订单时间线,在此节点点「确认」。`,
        relatedOrderId: milestone.order_id,
      });
    }
  } catch { /* 通知非主链路,忽略 */ }
}

async function userAndRoles(supabase: any): Promise<{ userId?: string; roles: string[]; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { roles: [], error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { userId: user.id, roles };
}

/** 按配置懒建缺失的确认行(幂等;insert 冲突静默忽略)。 */
async function ensureConfirmationRows(supabase: any, milestone: { id: string; order_id: string; step_key: string; name?: string | null }) {
  const parties = requiredPartiesFor(milestone.step_key);
  if (parties.length === 0) return;
  const { data: existing } = await (supabase.from('milestone_confirmations') as any)
    .select('party_key').eq('milestone_id', milestone.id);
  const have = new Set((existing || []).map((r: any) => r.party_key));
  const missing = parties.filter(p => !have.has(p.key));
  if (missing.length === 0) return;
  // UNIQUE(milestone_id, party_key) 兜底并发;冲突不报错(upsert ignoreDuplicates)
  await (supabase.from('milestone_confirmations') as any).upsert(
    missing.map(p => ({
      milestone_id: milestone.id, order_id: milestone.order_id,
      step_key: milestone.step_key, party_key: p.key, party_label: p.label,
    })),
    { onConflict: 'milestone_id,party_key', ignoreDuplicates: true },
  );
  // 首次建 pending 行 = 这些方第一次被要求确认 → 主动通知(只对新建的方发一次,避免每次查看都刷屏)
  await notifyPendingParties(milestone, missing);
}

/**
 * 某节点的确认状态(带当前用户能否代表各方确认)。
 * 非多方节点返回 parties: []( UI 据此不渲染)。
 */
export async function listMilestoneConfirmations(milestoneId: string): Promise<{
  parties?: Array<{
    party_key: string; party_label: string; hint?: string;
    status: 'pending' | 'confirmed';
    confirmed_at?: string | null; confirmed_by_name?: string | null; note?: string | null;
    canConfirm: boolean;
  }>;
  error?: string;
}> {
  const supabase = await createClient();
  const auth = await userAndRoles(supabase);
  if (!auth.userId) return { error: auth.error };

  const { data: ms, error: msErr } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, name').eq('id', milestoneId).single();
  if (msErr || !ms) return { error: msErr?.message || '找不到该节点' };

  const config = requiredPartiesFor((ms as any).step_key);
  if (config.length === 0) return { parties: [] };

  await ensureConfirmationRows(supabase, ms as any);

  const { data: rows, error } = await (supabase.from('milestone_confirmations') as any)
    .select('party_key, status, confirmed_by, confirmed_at, note').eq('milestone_id', milestoneId);
  if (error) return { error: error.message };

  // 确认人名字
  const uids = [...new Set((rows || []).map((r: any) => r.confirmed_by).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  if (uids.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any)
      .select('user_id, name').in('user_id', uids);
    for (const p of (profs || [])) nameMap[(p as any).user_id] = (p as any).name;
  }

  const byKey = new Map<string, any>((rows || []).map((r: any) => [r.party_key, r]));
  return {
    parties: config.map(p => {
      const row = byKey.get(p.key);
      return {
        party_key: p.key, party_label: p.label, hint: p.hint,
        status: (row?.status === 'confirmed' ? 'confirmed' : 'pending') as 'pending' | 'confirmed',
        confirmed_at: row?.confirmed_at || null,
        confirmed_by_name: row?.confirmed_by ? (nameMap[row.confirmed_by] || '已确认') : null,
        note: row?.note || null,
        canConfirm: canConfirmParty(auth.roles, p),
      };
    }),
  };
}

/**
 * 代表某方确认节点。幂等(已确认再点 = 直接 ok)。
 * 返回 allConfirmed:是否全齐;autoCompleted:是否已自动完成节点。
 */
export async function confirmMilestoneParty(milestoneId: string, partyKey: string, note?: string): Promise<{
  ok?: boolean; allConfirmed?: boolean; autoCompleted?: boolean; needsEvidence?: boolean; error?: string;
}> {
  const supabase = await createClient();
  const auth = await userAndRoles(supabase);
  if (!auth.userId) return { error: auth.error };

  const { data: ms, error: msErr } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, name, status, evidence_required').eq('id', milestoneId).single();
  if (msErr || !ms) return { error: msErr?.message || '找不到该节点' };

  const stepKey = (ms as any).step_key;
  const party = requiredPartiesFor(stepKey).find(p => p.key === partyKey);
  if (!party) return { error: '该节点没有这个确认方' };
  if (!canConfirmParty(auth.roles, party)) {
    return { error: `需要「${party.label}」相关角色(${party.roles.join('/')})才能代表该方确认` };
  }
  const msStatus = String((ms as any).status || '').toLowerCase();
  if (msStatus === 'done' || msStatus === '已完成') return { ok: true, allConfirmed: true };

  await ensureConfirmationRows(supabase, ms as any);

  const isAdminProxy = !party.roles.some(r => auth.roles.map(x => x.toLowerCase()).includes(r));
  const { error: upErr } = await (supabase.from('milestone_confirmations') as any)
    .update({
      status: 'confirmed', confirmed_by: auth.userId,
      confirmed_at: new Date().toISOString(), note: note?.trim() || null,
    })
    .eq('milestone_id', milestoneId).eq('party_key', partyKey);
  if (upErr) {
    if (/does not exist|schema cache/i.test(upErr.message || '')) {
      return { error: '确认表尚未建立:请先在 Supabase 执行 20260703_milestone_confirmations.sql' };
    }
    return { error: upErr.message };
  }

  // 审计日志
  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: milestoneId,
    order_id: (ms as any).order_id,
    action: 'party_confirmed',
    note: `「${party.label}」确认${isAdminProxy ? '(管理员代确认)' : ''}${note?.trim() ? ':' + note.trim() : ''}`,
    payload: { party_key: partyKey, by: auth.userId, admin_proxy: isAdminProxy },
  });

  // 全齐了吗?
  const { data: rows } = await (supabase.from('milestone_confirmations') as any)
    .select('party_key, status').eq('milestone_id', milestoneId);
  const confirmedKeys = new Set<string>((rows || []).filter((r: any) => r.status === 'confirmed').map((r: any) => r.party_key));
  const remaining = pendingParties(stepKey, confirmedKeys);
  if (remaining.length > 0) {
    // 一方已确认、还差其他方 → 再次提醒仍未确认的方(别让确认卡在"没人知道要确认")
    await notifyPendingParties(ms as any, remaining);
    revalidatePath(`/orders/${(ms as any).order_id}`);
    return { ok: true, allConfirmed: false };
  }

  // 全齐:免证据 → 自动完成;要证据 → 留给负责人上传凭证后正常点完成
  if ((ms as any).evidence_required) {
    revalidatePath(`/orders/${(ms as any).order_id}`);
    return { ok: true, allConfirmed: true, needsEvidence: true };
  }

  const now = new Date().toISOString();
  const { error: doneErr } = await (supabase.from('milestones') as any)
    .update({ status: 'done', completed_at: now, actual_at: now, updated_at: now })
    .eq('id', milestoneId);
  if (!doneErr) {
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: milestoneId,
      order_id: (ms as any).order_id,
      action: 'status_transition',
      note: `多方确认全部完成 → 系统自动完成「${(ms as any).name || stepKey}」`,
      payload: { auto: true, source: 'milestone_confirmations.all_confirmed' },
    });
    // fire-and-forget:交付置信度重算(内部已 catch 所有错)
    void (async () => {
      try {
        const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
        await recomputeDeliveryConfidence((ms as any).order_id, {
          type: 'milestone_status_changed',
          source: `milestone:${milestoneId}`,
          severity: 'info',
          payload: { milestone_id: milestoneId, new_status: 'done', auto: 'all_parties_confirmed' },
        });
      } catch { /* 忽略 */ }
    })();
  }

  revalidatePath(`/orders/${(ms as any).order_id}`);
  return { ok: true, allConfirmed: true, autoCompleted: !doneErr };
}
