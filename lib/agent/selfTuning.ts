/**
 * Agent 自我调参 — 根据历史执行率自动调整建议策略
 *
 * 每周运行一次，分析过去7天的建议执行率：
 * - 执行率高的建议类型 → 降低触发阈值（提前触发）
 * - 执行率低的建议类型 → 提高触发阈值（减少噪音）
 */

export interface TuningResult {
  actionType: string;
  totalCount: number;
  executedCount: number;
  dismissedCount: number;
  executionRate: number;
  adjustment: 'lower_threshold' | 'raise_threshold' | 'no_change';
  note: string;
}

export async function analyzeAndTune(supabase: any): Promise<TuningResult[]> {
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data: actions } = await supabase
    .from('agent_actions')
    .select('action_type, status')
    .gte('created_at', weekAgo)
    .in('status', ['executed', 'dismissed']);

  if (!actions || actions.length < 10) return []; // 样本不足

  // 按类型统计
  const stats: Record<string, { executed: number; dismissed: number }> = {};
  for (const a of actions) {
    if (!stats[a.action_type]) stats[a.action_type] = { executed: 0, dismissed: 0 };
    if (a.status === 'executed') stats[a.action_type].executed++;
    else stats[a.action_type].dismissed++;
  }

  const results: TuningResult[] = [];
  for (const [type, s] of Object.entries(stats)) {
    const total = s.executed + s.dismissed;
    const rate = Math.round((s.executed / total) * 100);

    let adjustment: 'lower_threshold' | 'raise_threshold' | 'no_change' = 'no_change';
    let note = '';

    if (rate >= 80 && total >= 5) {
      adjustment = 'lower_threshold';
      note = `执行率${rate}%很高，建议提前触发此类建议`;
    } else if (rate <= 20 && total >= 5) {
      adjustment = 'raise_threshold';
      note = `执行率${rate}%很低，建议减少此类建议频率`;
    } else {
      note = `执行率${rate}%，保持当前策略`;
    }

    results.push({
      actionType: type,
      totalCount: total,
      executedCount: s.executed,
      dismissedCount: s.dismissed,
      executionRate: rate,
      adjustment,
      note,
    });
  }

  // 将调参结果写入 ai_knowledge_base 供后续参考
  try {
    await supabase.from('ai_knowledge_base').insert({
      source_type: 'agent_tuning',
      category: 'self_tuning',
      title: `Agent 自调参 — ${new Date().toISOString().slice(0, 10)}`,
      content: JSON.stringify(results),
      structured_data: { results, timestamp: new Date().toISOString() },
      confidence: 0.8,
    });
  } catch {}

  return results;
}
