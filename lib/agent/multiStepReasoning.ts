/**
 * 多轮推理引擎 — 催办→观察→再判断
 *
 * 不是简单的链式动作（A→B），而是：
 * 催办 → 等待观察期 → 检查是否有进展 → 根据结果决定下一步
 *
 * 推理链：
 * Round 1: 超期2天 → 催办负责人
 * Round 2: 催办后24h → 检查节点是否有操作记录
 *   → 有进展 → 记录"催办有效"，结束
 *   → 无进展 → 升级到部门主管
 * Round 3: 升级后24h → 检查是否有进展
 *   → 有进展 → 结束
 *   → 无进展 → 升级CEO + 标记高风险
 */

export interface ReasoningStep {
  round: number;
  action: string;
  condition: string;
  result?: 'progress' | 'no_progress' | 'pending';
  nextAction?: string;
  observation?: string;
}

/**
 * 检查已催办的节点是否有进展（多轮推理 Round 2）
 */
export async function checkProgressAfterNudge(
  supabase: any,
  milestoneId: string,
  nudgeTime: string,
): Promise<{ hasProgress: boolean; observation: string }> {
  // 检查催办后是否有操作记录
  const { data: logs } = await supabase
    .from('milestone_logs')
    .select('action, note, created_at')
    .eq('milestone_id', milestoneId)
    .gte('created_at', nudgeTime)
    .order('created_at', { ascending: false })
    .limit(5);

  if (logs && logs.length > 0) {
    const actions = logs.map((l: any) => l.action);
    if (actions.includes('mark_done')) {
      return { hasProgress: true, observation: '节点已完成' };
    }
    if (actions.includes('mark_in_progress') || actions.includes('upload_evidence')) {
      return { hasProgress: true, observation: '有操作记录，正在处理中' };
    }
    if (actions.includes('request_delay')) {
      return { hasProgress: true, observation: '已提交延期申请' };
    }
    return { hasProgress: true, observation: `有 ${logs.length} 条操作记录` };
  }

  // 检查节点状态是否变化
  const { data: milestone } = await supabase
    .from('milestones')
    .select('status, notes, updated_at')
    .eq('id', milestoneId)
    .single();

  if (milestone && new Date(milestone.updated_at) > new Date(nudgeTime)) {
    return { hasProgress: true, observation: '节点有更新' };
  }

  return { hasProgress: false, observation: '催办后无任何进展' };
}

/**
 * 执行多轮推理（在 Cron 中调用）
 * 扫描已执行的催办动作，检查后续进展
 */
export async function executeMultiStepReasoning(supabase: any): Promise<number> {
  let escalated = 0;

  // 找到24h前执行的催办动作，且还没有后续观察
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: nudgeActions } = await supabase
    .from('agent_actions')
    .select('id, milestone_id, order_id, executed_at, action_payload')
    .eq('action_type', 'send_nudge')
    .eq('status', 'executed')
    .gt('executed_at', fortyEightHoursAgo)
    .lt('executed_at', twentyFourHoursAgo);

  for (const action of nudgeActions || []) {
    if (!action.milestone_id || !action.executed_at) continue;
    const payload = action.action_payload as any;
    // 跳过已经有后续推理的
    if (payload?.reasoning_checked) continue;

    const { hasProgress, observation } = await checkProgressAfterNudge(
      supabase, action.milestone_id, action.executed_at
    );

    // 记录观察结果
    await supabase.from('agent_actions').update({
      action_payload: { ...payload, reasoning_checked: true, reasoning_result: hasProgress ? 'progress' : 'no_progress', reasoning_observation: observation },
    }).eq('id', action.id);

    if (!hasProgress) {
      // 无进展 → 升级：生成 escalate_ceo 建议
      const dedupKey = `reasoning:escalate:${action.milestone_id}:${new Date().toISOString().slice(0, 10)}`;
      const { data: existing } = await supabase.from('agent_actions').select('id').eq('dedup_key', dedupKey).in('status', ['pending', 'executing']).limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from('agent_actions').insert({
          order_id: action.order_id,
          milestone_id: action.milestone_id,
          action_type: 'escalate_ceo',
          title: `🧠 多轮推理：催办24h无进展，建议升级`,
          description: `催办后观察：${observation}。建议升级管理层介入。`,
          reason: '多轮推理链：催办→24h观察→无进展→升级CEO',
          severity: 'high',
          action_payload: { reasoning_round: 2, previous_action_id: action.id },
          status: 'pending',
          dedup_key: dedupKey,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        escalated++;
      }
    }

    // 有进展 → 记录"催办有效"到客户记忆
    if (hasProgress) {
      await supabase.from('customer_memory').insert({
        customer_id: payload?.target_name || 'system',
        order_id: action.order_id,
        source_type: 'agent_reasoning',
        content: `催办有效：${observation}`,
        category: 'general',
        risk_level: 'low',
      }).catch(() => {});
    }
  }

  return escalated;
}
