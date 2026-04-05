'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { CIRCUIT_BREAKER } from '@/lib/agent/types';

/**
 * 执行 Agent 建议
 */
export async function executeAgentAction(actionId: string): Promise<{ error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: '请先登录' };

    // 获取建议（原子更新防双击：C3 幂等性修复）
    const { data: action, error: claimErr } = await (supabase.from('agent_actions') as any)
      .update({ status: 'executing' })
      .eq('id', actionId)
      .eq('status', 'pending')
      .select('*')
      .single();
    if (claimErr || !action) return { error: '建议不存在或已被处理' };

    // 过期检查
    if (action.expires_at && new Date(action.expires_at) < new Date()) {
      await (supabase.from('agent_actions') as any).update({ status: 'expired' }).eq('id', actionId);
      return { error: '建议已过期' };
    }

    // 角色验证（C2）
    const { data: profile } = await supabase.from('profiles').select('roles, role').eq('user_id', user.id).single();
    const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
    const isAdmin = userRoles.includes('admin');
    const { ACTION_CONFIG } = await import('@/lib/agent/types');
    const config = ACTION_CONFIG[action.action_type as keyof typeof ACTION_CONFIG];
    if (config?.requiredRoles?.length > 0 && !isAdmin) {
      const hasRole = config.requiredRoles.some((r: string) => userRoles.includes(r));
      if (!hasRole) {
        // 回滚 status
        await (supabase.from('agent_actions') as any).update({ status: 'pending' }).eq('id', actionId);
        return { error: `无权执行此操作，需要角色：${config.requiredRoles.join('/')}` };
      }
    }

    // 熔断检查：单订单每天限制
    const today = new Date().toISOString().slice(0, 10);
    const { count: orderCount } = await (supabase.from('agent_actions') as any)
      .select('id', { count: 'exact', head: true })
      .eq('order_id', action.order_id)
      .eq('status', 'executed')
      .gte('executed_at', today + 'T00:00:00Z');
    if ((orderCount || 0) >= CIRCUIT_BREAKER.maxPerOrderPerDay) {
      return { error: `该订单今日已执行 ${CIRCUIT_BREAKER.maxPerOrderPerDay} 个建议，已达上限` };
    }

    // 熔断检查：全局每小时限制
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: globalCount } = await (supabase.from('agent_actions') as any)
      .select('id', { count: 'exact', head: true })
      .eq('status', 'executed')
      .gte('executed_at', oneHourAgo);
    if ((globalCount || 0) >= CIRCUIT_BREAKER.maxGlobalPerHour) {
      return { error: '系统繁忙，请稍后再试' };
    }

    // 执行动作
    const payload = action.action_payload || {};
    let rollbackData: Record<string, any> | null = null;

    switch (action.action_type) {
      case 'assign_owner': {
        // 保存回滚数据
        const { data: ms } = await (supabase.from('milestones') as any)
          .select('owner_user_id').eq('id', action.milestone_id).single();
        rollbackData = { original_owner_user_id: ms?.owner_user_id || null };
        // 执行分配
        await (supabase.from('milestones') as any)
          .update({ owner_user_id: payload.target_user_id })
          .eq('id', action.milestone_id);
        break;
      }

      case 'send_nudge': {
        // 调用催办 API
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL}/api/nudge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            milestoneId: action.milestone_id,
            message: `[Agent] ${action.title}`,
          }),
        }).catch(() => {});
        break;
      }

      case 'create_delay_draft': {
        const { data: delayReq, error: delayErr } = await (supabase.from('delay_requests') as any)
          .insert({
            order_id: action.order_id,
            milestone_id: action.milestone_id,
            requested_by: user.id,
            reason_type: 'internal_delay',
            reason_detail: `[Agent 建议] ${action.description}`,
            proposed_new_due_at: new Date(Date.now() + (payload.suggested_days || 7) * 86400000).toISOString(),
            status: 'pending',
          })
          .select('id')
          .single();
        if (delayErr) return { error: '创建延期申请失败: ' + delayErr.message };
        rollbackData = { delay_request_id: delayReq?.id };
        break;
      }

      case 'mark_blocked': {
        const { data: ms } = await (supabase.from('milestones') as any)
          .select('status, notes').eq('id', action.milestone_id).single();
        rollbackData = { original_status: ms?.status, original_notes: ms?.notes };
        await (supabase.from('milestones') as any)
          .update({
            status: 'blocked',
            notes: `[Agent] ${action.reason}\n${ms?.notes || ''}`.trim(),
          })
          .eq('id', action.milestone_id);
        break;
      }

      case 'add_note': {
        const { data: ms } = await (supabase.from('milestones') as any)
          .select('notes').eq('id', action.milestone_id).single();
        rollbackData = { original_notes: ms?.notes };
        const newNote = `[${new Date().toLocaleDateString('zh-CN')}] ${action.description}`;
        await (supabase.from('milestones') as any)
          .update({ notes: `${newNote}\n${ms?.notes || ''}`.trim() })
          .eq('id', action.milestone_id);
        break;
      }

      case 'escalate_ceo': {
        // 获取管理员列表
        const { data: admins } = await (supabase.from('profiles') as any)
          .select('user_id').or("role.eq.admin,roles.cs.{admin}");
        for (const admin of admins || []) {
          await (supabase.from('notifications') as any).insert({
            user_id: admin.user_id,
            type: 'agent_escalation',
            title: `🚨 Agent 升级：${action.title}`,
            message: action.description,
            related_order_id: action.order_id,
            status: 'unread',
          });
        }
        break;
      }

      case 'notify_next':
      case 'remind_missing_doc': {
        const targetUserId = payload.target_user_id;
        if (targetUserId) {
          await (supabase.from('notifications') as any).insert({
            user_id: targetUserId,
            type: action.action_type === 'notify_next' ? 'agent_notify' : 'agent_remind',
            title: action.title,
            message: action.description,
            related_order_id: action.order_id,
            related_milestone_id: action.milestone_id || null,
            status: 'unread',
          });
        }
        break;
      }
    }

    // 更新状态为已执行
    await (supabase.from('agent_actions') as any)
      .update({
        status: 'executed',
        executed_by: user.id,
        executed_at: new Date().toISOString(),
        rollback_data: rollbackData,
      })
      .eq('id', actionId);

    // 写审计日志
    if (action.milestone_id) {
      await (supabase.from('milestone_logs') as any).insert({
        milestone_id: action.milestone_id,
        order_id: action.order_id,
        actor_user_id: user.id,
        action: 'agent_execute',
        note: `[Agent] ${action.title}`,
        payload: { agent_action_id: actionId, action_type: action.action_type },
      });
    }

    revalidatePath(`/orders/${action.order_id}`);
    revalidatePath('/ceo');
    return {};
  } catch (err: any) {
    return { error: `执行异常: ${err?.message || '未知错误'}` };
  }
}

/**
 * 忽略 Agent 建议
 */
export async function dismissAgentAction(actionId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  await (supabase.from('agent_actions') as any)
    .update({ status: 'dismissed', dismissed_by: user.id, dismissed_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('status', 'pending');
  return {};
}

/**
 * 回滚 Agent 动作（48小时内）
 */
export async function rollbackAgentAction(actionId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: action } = await (supabase.from('agent_actions') as any)
    .select('*').eq('id', actionId).single();
  if (!action) return { error: '动作不存在' };
  if (action.status !== 'executed') return { error: '只能回滚已执行的动作' };
  if (action.rolled_back) return { error: '已回滚过' };

  // 48小时限制
  const executedAt = new Date(action.executed_at).getTime();
  if (Date.now() - executedAt > 48 * 60 * 60 * 1000) {
    return { error: '超过48小时，无法回滚' };
  }

  const rollback = action.rollback_data;
  if (!rollback) return { error: '该动作不支持回滚' };

  switch (action.action_type) {
    case 'assign_owner':
      await (supabase.from('milestones') as any)
        .update({ owner_user_id: rollback.original_owner_user_id || null })
        .eq('id', action.milestone_id);
      break;
    case 'mark_blocked':
      await (supabase.from('milestones') as any)
        .update({ status: rollback.original_status || 'in_progress', notes: rollback.original_notes || null })
        .eq('id', action.milestone_id);
      break;
    case 'add_note':
      await (supabase.from('milestones') as any)
        .update({ notes: rollback.original_notes || null })
        .eq('id', action.milestone_id);
      break;
    case 'create_delay_draft':
      if (rollback.delay_request_id) {
        await (supabase.from('delay_requests') as any)
          .delete().eq('id', rollback.delay_request_id).eq('status', 'pending');
      }
      break;
  }

  await (supabase.from('agent_actions') as any)
    .update({ rolled_back: true })
    .eq('id', actionId);

  revalidatePath(`/orders/${action.order_id}`);
  return {};
}
