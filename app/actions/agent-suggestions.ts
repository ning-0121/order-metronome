'use server';

import { createClient } from '@/lib/supabase/server';
import { generateSuggestionsForOrder } from '@/lib/agent/generateSuggestions';
import type { AgentSuggestion } from '@/lib/agent/types';
import { CIRCUIT_BREAKER } from '@/lib/agent/types';

/**
 * 获取指定订单的 Agent 建议
 * 1. 先查数据库中已有的 pending 建议
 * 2. 如果没有，实时生成并存入数据库
 */
export async function getAgentSuggestions(orderId: string): Promise<{ data: AgentSuggestion[] }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [] };

    // 清理过期建议
    await (supabase.from('agent_actions') as any)
      .update({ status: 'expired' })
      .eq('order_id', orderId)
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());

    // 查已有 pending 建议
    const { data: existing } = await (supabase.from('agent_actions') as any)
      .select('*')
      .eq('order_id', orderId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (existing && existing.length > 0) {
      return { data: existing.map(mapToSuggestion) };
    }

    // 没有 pending 建议，实时生成
    const { data: order } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, factory_name')
      .eq('id', orderId).single();
    if (!order) return { data: [] };

    const { data: milestones } = await (supabase.from('milestones') as any)
      .select('id, step_key, name, status, due_at, owner_role, owner_user_id, evidence_required, is_critical')
      .eq('order_id', orderId);

    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email, role, roles');
    const profileList = (profiles || []).map((p: any) => ({
      user_id: p.user_id,
      name: p.name,
      email: p.email,
      roles: p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean),
    }));

    // 获取已有动作记录（用于防重复）
    const { data: allActions } = await (supabase.from('agent_actions') as any)
      .select('dedup_key, status, created_at')
      .eq('order_id', orderId);

    const suggestions = generateSuggestionsForOrder(order, milestones || [], profileList, allActions || []);

    // 存入数据库
    if (suggestions.length > 0) {
      const rows = suggestions.map(s => ({
        order_id: s.orderId,
        milestone_id: s.milestoneId || null,
        action_type: s.actionType,
        title: s.title,
        description: s.description,
        reason: s.reason,
        severity: s.severity,
        action_payload: s.payload,
        status: 'pending',
        dedup_key: s.payload.dedup_key,
        expires_at: new Date(Date.now() + CIRCUIT_BREAKER.expirationHours * 60 * 60 * 1000).toISOString(),
      }));
      const { data: inserted } = await (supabase.from('agent_actions') as any)
        .insert(rows).select('*');
      if (inserted) {
        return { data: inserted.map(mapToSuggestion) };
      }
    }

    return { data: [] };
  } catch (err: any) {
    console.error('[getAgentSuggestions]', err?.message);
    return { data: [] };
  }
}

/**
 * 获取全局 pending 建议（CEO 页面用）
 */
export async function getAllPendingAgentSuggestions(): Promise<{ data: AgentSuggestion[] }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [] };

    // 清理过期
    await (supabase.from('agent_actions') as any)
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());

    const { data: pending } = await (supabase.from('agent_actions') as any)
      .select('*, orders!inner(order_no)')
      .eq('status', 'pending')
      .order('severity', { ascending: true }) // high first
      .order('created_at', { ascending: false })
      .limit(15);

    return { data: (pending || []).map(mapToSuggestion) };
  } catch {
    return { data: [] };
  }
}

function mapToSuggestion(row: any): AgentSuggestion {
  const { ACTION_CONFIG } = require('@/lib/agent/types');
  const config = ACTION_CONFIG[row.action_type] || {};
  return {
    id: row.id,
    orderId: row.order_id,
    orderNo: row.orders?.order_no || row.order_no || '',
    milestoneId: row.milestone_id,
    milestoneName: row.milestone_name,
    actionType: row.action_type,
    title: row.title,
    description: row.description || '',
    reason: row.reason || '',
    severity: row.severity || 'medium',
    primaryButton: {
      label: config.buttonLabel || '执行',
      confirmMessage: config.confirmMessage,
    },
    payload: row.action_payload || {},
    status: row.status,
    executedAt: row.executed_at,
    canRollback: config.canRollback || false,
  };
}
