/**
 * 临时诊断:在生产运行时(有真 ANTHROPIC key)跑一次 CEO 委托抽取,回传原始结构+延迟。
 * CRON_SECRET 鉴权,不入业务;跑完自清 capture。**验完即删。**
 */
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const text = new URL(req.url).searchParams.get('text')
    || '让欧璐把 Gregory 当前项目的新报价明天下午前做好,利润低于15%不要发。';

  const t0 = Date.now();
  let extraction: any = null, aiError: string | null = null;
  try {
    const { qimoAI } = await import('@/lib/ai/runtime');
    const { delegationExtractValidator, DELEGATION_EXTRACT_SYSTEM } = await import('@/lib/ai/scenes/delegation-extract');
    const r = await qimoAI.generateObject({
      scene: 'exec.delegation.extract', capability: 'structured-extraction',
      logicalModel: 'qimo.structured-extraction', riskLevel: 'high',
      system: DELEGATION_EXTRACT_SYSTEM, prompt: `CEO 的交代:\n${text}`,
      schema: delegationExtractValidator, timeoutMs: 30_000, maxOutputTokens: 2048, fallback: 'disabled',
    });
    extraction = r.data;
  } catch (e: any) {
    // 挖 cause 链(runtime 网关把底层 SDK 错包了好几层)
    const chain: string[] = [];
    let cur: any = e;
    for (let i = 0; i < 6 && cur; i++) { chain.push(`${cur?.code || cur?.name || ''}: ${cur?.message || String(cur)}`.slice(0, 200)); cur = cur?.cause || cur?.lastError; }
    aiError = chain.join(' <- ');
  }
  // 直连对照:同 key 直接调 Anthropic 一次(证明 key 本身通不通)
  let directProbe: string | null = null;
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const r = await c.messages.create({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    directProbe = 'ok:' + (r.model || '?');
  } catch (e: any) { directProbe = 'fail:' + (e?.status || '') + ':' + (e?.message || String(e)).slice(0, 160); }
  const latencyMs = Date.now() - t0;

  // 顺带验 owner/对手方消歧(不写业务,只读)
  let ownerResolve: any = null, counterpartyResolve: any = null;
  if (extraction?.items?.length) {
    const svc = createServiceRoleClient();
    const deleg = extraction.items.find((i: any) => i.item_type === 'proposed_delegation');
    if (deleg?.owner_hint) {
      const { data } = await (svc.from('profiles') as any).select('user_id, name').ilike('name', `%${deleg.owner_hint}%`).limit(5);
      ownerResolve = { hint: deleg.owner_hint, matches: (data || []).map((d: any) => d.name), count: (data || []).length };
    }
    const cpHint = deleg?.person || deleg?.customer_hint;
    if (cpHint) {
      const { data } = await (svc.from('customers') as any).select('id, name').ilike('name', `%${cpHint}%`).limit(3);
      counterpartyResolve = { hint: cpHint, matched: (data || []).length > 0, matches: (data || []).map((d: any) => d.name) };
    }
  }

  return NextResponse.json({ input: text, latencyMs, aiError, directProbe, extraction, ownerResolve, counterpartyResolve });
}
