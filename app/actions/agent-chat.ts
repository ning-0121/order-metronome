'use server';

import { createClient } from '@/lib/supabase/server';
import { buildAgentChatPayload, type AgentChatMessage } from '@/lib/agent/chatContext';

/**
 * Agent 对话 — 业务员的 AI 专业助手（小绮）
 *
 * 主路径是流式的 /api/agent-chat(边生成边显示);本 action 为非流式兜底,
 * 上下文构建与流式路径共用 lib/agent/chatContext.ts,喂给 Claude 的内容一致。
 *
 * 安全：只查询当前用户可见的数据
 */

export type ChatMessage = AgentChatMessage;

export async function askAgent(
  question: string,
  history?: ChatMessage[],
): Promise<{ answer: string; error?: string }> {
  const aiStartedAt = Date.now();
  const { logAICall } = await import('@/lib/ai/rate-limit');
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { answer: '', error: '请先登录' };
    if (!question.trim()) return { answer: '', error: '请输入问题' };

    // ═══ AI 限速（2026-05-19 补：之前 askAgent 是登录后无限刷的入口）═══
    const { guardAICall } = await import('@/lib/ai/rate-limit');
    const guard = await guardAICall('agent_chat');
    if (!guard.ok) return { answer: '', error: guard.error };

    const { systemBlocks, claudeMessages } = await buildAgentChatPayload(supabase, user, question, history);

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1600,
      system: systemBlocks,
      messages: claudeMessages,
    });

    // 打印 cache 命中日志
    const usage = response.usage as any;
    if (usage?.cache_read_input_tokens > 0) {
      console.log(`[askAgent] 💰 cache HIT ${usage.cache_read_input_tokens} tokens`);
    }

    const answer = response.content[0].type === 'text' ? response.content[0].text : '无法回答';
    logAICall('agent_chat', null, 'success', Date.now() - aiStartedAt).catch(() => {});
    return { answer };
  } catch (err: any) {
    console.error('[askAgent]', err?.message);
    logAICall('agent_chat', null, 'error', Date.now() - aiStartedAt, err?.message?.slice(0, 200)).catch(() => {});
    if (err?.message?.includes('credit') || err?.message?.includes('billing')) {
      return { answer: '', error: 'AI 服务余额不足，请联系管理员充值' };
    }
    return { answer: '', error: '回答失败，请稍后再试' };
  }
}
