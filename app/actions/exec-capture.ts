'use server';

/**
 * Executive OS V1 · Capture + Extraction(S1+S2 的 command 层)。
 *
 * 三层语义严格分离:
 *   captureCeoInput → executive_captures(raw,永不覆盖)
 *   parseCapture    → executive_capture_items(AI 草案,待确认)
 * 确认在 exec-delegation.ts。所有写走 service-role(RLS 无写策略)+ 安全断言。
 * 仅 CEO(admin 白名单)可捕获;Agent 不自主生效任何东西。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { safeMutation } from '@/lib/db/safe-mutation';
import { createHash } from 'node:crypto';

async function requireCeo() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = p?.roles?.length ? p.roles : [p?.role].filter(Boolean);
  if (!roles.includes('admin')) return { error: '仅管理员(CEO)可使用委托捕获' as const };
  return { userId: user.id };
}

export interface CaptureItemView {
  id: string; item_type: string; structured_payload: any; confidence: number | null;
  confirmation_status: string;
}

/** S1:落 CEO 原始输入。idempotency_key 防 API retry 重复;content_hash 仅内容指纹。 */
export async function captureCeoInput(
  rawText: string,
  idempotencyKey?: string,
): Promise<{ captureId?: string; error?: string; reused?: boolean }> {
  const auth = await requireCeo();
  if ('error' in auth) return { error: auth.error };
  const text = (rawText || '').trim();
  if (!text) return { error: '请输入要交代的内容' };

  const svc = createServiceRoleClient();
  // 修正②:命令级幂等 —— 同 idempotency_key 直接复用,不重复建
  if (idempotencyKey) {
    const { data: existing } = await (svc.from('executive_captures') as any)
      .select('id').eq('idempotency_key', idempotencyKey).maybeSingle();
    if (existing) return { captureId: (existing as any).id, reused: true };
  }
  const contentHash = createHash('sha256').update(text).digest('hex');

  const res = await safeMutation<{ id: string }>({
    client: svc, table: 'executive_captures', operation: 'insert', expectedRows: 1,
    payload: {
      actor_user_id: auth.userId, source_type: 'text', raw_text: text,
      content_hash: contentHash, idempotency_key: idempotencyKey || null,
      processing_status: 'captured',
    },
  });
  if (!res.ok) return { error: `捕获失败(${res.status}):${res.error}` };
  return { captureId: res.data![0].id };
}

/** S2:AI 抽取草案。不信任、不生效 —— 只落 capture_items 供 CEO 确认卡。 */
export async function parseCapture(captureId: string): Promise<{ items?: CaptureItemView[]; error?: string }> {
  const auth = await requireCeo();
  if ('error' in auth) return { error: auth.error };
  const svc = createServiceRoleClient();

  const { data: cap } = await (svc.from('executive_captures') as any)
    .select('id, raw_text, processing_status').eq('id', captureId).maybeSingle();
  if (!cap) return { error: '捕获记录不存在' };

  // 幂等:已抽过直接回读(重复点不重复烧 token)
  const { data: existing } = await (svc.from('executive_capture_items') as any)
    .select('id, item_type, structured_payload, confidence, confirmation_status').eq('capture_id', captureId);
  if ((existing || []).length > 0) return { items: existing as CaptureItemView[] };

  await (svc.from('executive_captures') as any).update({ processing_status: 'parsing' }).eq('id', captureId);

  const parseStart = Date.now();
  let items: any[] = [];
  try {
    const { qimoAI } = await import('@/lib/ai/runtime');
    const { delegationExtractValidator, DELEGATION_EXTRACT_SYSTEM } = await import('@/lib/ai/scenes/delegation-extract');
    const result = await qimoAI.generateObject({
      scene: 'exec.delegation.extract', capability: 'structured-extraction',
      logicalModel: 'qimo.structured-extraction', riskLevel: 'high',
      system: DELEGATION_EXTRACT_SYSTEM, prompt: `CEO 的交代:\n${cap.raw_text}`,
      schema: delegationExtractValidator, timeoutMs: 30_000, maxOutputTokens: 2048, fallback: 'disabled',
    });
    items = result.data.items || [];
  } catch (e: any) {
    // AI 失败不静默:capture 标 parsed(0 项),确认卡显示"没抽到,可手动补"
    await (svc.from('executive_captures') as any).update({ processing_status: 'parsed' }).eq('id', captureId);
    return { error: `AI 理解失败:${e?.message || e}。可手动补录委托。`, items: [] };
  }

  // 落草案(逐条 insert;失败不静默)
  const rows = items.map((it) => ({
    capture_id: captureId, item_type: it.item_type,
    structured_payload: it, confidence: it.confidence ?? null, confirmation_status: 'pending',
  }));
  if (rows.length > 0) {
    const ins = await safeMutation({ client: svc, table: 'executive_capture_items', operation: 'insert', payload: rows, expectedRows: rows.length });
    if (!ins.ok) return { error: `草案落库失败(${ins.status}):${ins.error}` };
  }
  await (svc.from('executive_captures') as any).update({ processing_status: 'parsed' }).eq('id', captureId);

  // TS1 dogfood telemetry:只记延迟+抽到的字段结构(非原文),幂等 upsert 到该 capture
  try {
    const fields = items.map((it) => ({ item_type: it.item_type, keys: Object.keys(it).filter((k) => k !== 'confidence') }));
    const { data: ev } = await (svc.from('exec_validation_events') as any).select('id').eq('capture_id', captureId).maybeSingle();
    if (!ev) await (svc.from('exec_validation_events') as any).insert({
      capture_id: captureId, extraction_latency_ms: Date.now() - parseStart, extracted_fields: fields, retry_count: 0,
    });
    else await (svc.from('exec_validation_events') as any).update({ retry_count: ((ev as any).retry_count || 0) + 1, extraction_latency_ms: Date.now() - parseStart, extracted_fields: fields }).eq('id', (ev as any).id);
  } catch (e: any) { console.error('[telemetry] parse 记录失败(不阻断):', e?.message); }

  const { data: saved } = await (svc.from('executive_capture_items') as any)
    .select('id, item_type, structured_payload, confidence, confirmation_status').eq('capture_id', captureId);
  return { items: (saved || []) as CaptureItemView[] };
}
