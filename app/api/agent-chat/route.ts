/**
 * 小绮对话 — 流式主路径。
 * Server Action 无法流式返回,导致用户要等整段回复生成完才看到字(体感"非常慢")。
 * 此 route 边生成边推流,首字 1-2 秒可见。上下文构建与 askAgent 共用 chatContext。
 */

import { createClient } from '@/lib/supabase/server';
import { buildAgentChatPayload } from '@/lib/agent/chatContext';
import { guardAICall, logAICall } from '@/lib/ai/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { question, history } = await req.json();
    if (!question?.trim()) {
      return Response.json({ error: '请输入问题' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: '请先登录' }, { status: 401 });

    const guard = await guardAICall('agent_chat');
    if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });

    const { systemBlocks, claudeMessages } = await buildAgentChatPayload(supabase, user, question, history);

    const aiStartedAt = Date.now();
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const stream = client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 1600,
      system: systemBlocks,
      messages: claudeMessages,
    });

    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && (event as any).delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode((event as any).delta.text));
            }
          }
          logAICall('agent_chat', null, 'success', Date.now() - aiStartedAt).catch(() => {});
        } catch (err: any) {
          console.error('[agent-chat stream]', err?.message);
          controller.enqueue(encoder.encode('\n\n（回答中断,请重试）'));
          logAICall('agent_chat', null, 'error', Date.now() - aiStartedAt, err?.message?.slice(0, 200)).catch(() => {});
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    console.error('[agent-chat]', err?.message);
    if (err?.message?.includes('credit') || err?.message?.includes('billing')) {
      return Response.json({ error: 'AI 服务余额不足，请联系管理员充值' }, { status: 502 });
    }
    return Response.json({ error: '回答失败，请稍后再试' }, { status: 500 });
  }
}
