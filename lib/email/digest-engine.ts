/**
 * 邮件归纳引擎(Phase 1 Tier 1,2026-07-25 CEO 批)。
 * 增量拉未归纳邮件 → Tier 0 规则分类(噪音直接落库不喂 AI)→ Tier 1 Haiku **批量**摘要 → 物化到 mail_inbox 新列。
 * 省 token:一批多封一次调用、Haiku、system 走缓存(callClaudeJSON 默认 cacheSystem);噪音零 AI;只处理 digested_at IS NULL。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';
import { ruleClassify, MAIL_CATEGORIES, type MailCategory } from './classify';

const HAIKU = 'claude-haiku-4-5-20251001';
const AI_BATCH = 12;        // 每次 Haiku 调用打包封数(一批一调用)
const MAX_BODY = 1200;      // 每封正文喂给 AI 的截断(省 token)

// 静态 system(走 prompt 缓存,重复调用只收 10%)。
const SYSTEM = `你是外贸服装公司的邮件归纳助手。给你一批客户/供应商邮件,逐封输出结构化归纳。
类别只能取:${MAIL_CATEGORIES.join('、')}。
- 摘要 summary:一句话中文,≤40 字,说清"谁就哪个订单/款要什么或反映什么"。
- 重点度 importance:3=投诉/交期变更/紧急,需业务执行今天处理;2=需关注(样品反馈/PO/报价);1=一般知会。
- needs_action:是否需要业务执行采取行动(回复/改单/催确认/升级)。
- action_type:回复/改单/催确认/升级/无 之一。
只输出 JSON,不要任何解释。`;

export interface DigestInput { id: string; subject: string; body: string; ruleCategory: MailCategory; }
export interface DigestOutput {
  id: string; category: MailCategory; summary: string;
  importance: 1 | 2 | 3; needs_action: boolean; action_type: string;
}

/** 一批邮件 → 一次 Haiku 调用 → 结构化归纳。失败返回 null(调用方回退规则结果)。 */
export async function summarizeBatch(items: DigestInput[]): Promise<DigestOutput[] | null> {
  if (items.length === 0) return [];
  const payload = items.map((it, i) => ({
    ref: i,   // 用序号回指,避免把长 uuid 喂进去费 token
    subject: (it.subject || '').slice(0, 200),
    rule_guess: it.ruleCategory,
    body: (it.body || '').replace(/\s+/g, ' ').slice(0, MAX_BODY),
  }));
  const prompt = `按每封邮件输出归纳。返回 JSON:{"items":[{"ref":number,"category":string,"summary":string,"importance":1|2|3,"needs_action":boolean,"action_type":string}]}
rule_guess 是规则初判,仅供参考,你可纠正 category。
邮件批次:
${JSON.stringify(payload)}`;

  const res = await callClaudeJSON<{ items: any[] }>({
    scene: 'mail_digest',
    system: SYSTEM,
    prompt,
    model: HAIKU,
    maxTokens: 1600,
    timeoutMs: 30_000,
    cacheSystem: true,
  });
  if (!res || !Array.isArray(res.items)) return null;

  const out: DigestOutput[] = [];
  for (const r of res.items) {
    const idx = Number(r.ref);
    const src = items[idx];
    if (!src) continue;
    const category = (MAIL_CATEGORIES as string[]).includes(r.category) ? r.category as MailCategory : src.ruleCategory;
    const importance = ([1, 2, 3].includes(Number(r.importance)) ? Number(r.importance) : 1) as 1 | 2 | 3;
    out.push({
      id: src.id, category,
      summary: String(r.summary || '').slice(0, 120),
      importance,
      needs_action: !!r.needs_action,
      action_type: String(r.action_type || '无').slice(0, 20),
    });
  }
  return out;
}

/**
 * 跑一轮归纳(增量)。返回处理计数。cron / 手动都可调。
 * @param limit 本轮最多处理封数(默认 30,配合 cron 时间预算)。
 */
export async function runMailDigest(limit = 30): Promise<{
  scanned: number; noise: number; aiDigested: number; ruleFallback: number;
}> {
  const svc = createServiceRoleClient();
  // 增量:只取未归纳(digested_at IS NULL)的邮件
  const { data: rows } = await (svc.from('mail_inbox') as any)
    .select('id, subject, raw_body, order_id')
    .is('digested_at', null)
    .order('received_at', { ascending: false })
    .limit(limit);
  const emails = (rows || []) as any[];
  if (emails.length === 0) return { scanned: 0, noise: 0, aiDigested: 0, ruleFallback: 0 };

  const now = new Date().toISOString();
  let noise = 0, aiDigested = 0, ruleFallback = 0;

  // 归属业务执行:有 order_id 的批量查订单负责人
  const orderIds = [...new Set(emails.map((e) => e.order_id).filter(Boolean))];
  const execByOrder = new Map<string, string | null>();
  if (orderIds.length > 0) {
    const { data: ords } = await (svc.from('orders') as any)
      .select('id, owner_user_id, created_by').in('id', orderIds);
    for (const o of (ords || [])) execByOrder.set(o.id, o.owner_user_id || o.created_by || null);
  }
  const execFor = (e: any): string | null => (e.order_id ? execByOrder.get(e.order_id) ?? null : null);

  // Tier 0:规则分类。噪音直接落库(零 AI);其余进 AI 队列。
  const toAI: DigestInput[] = [];
  for (const e of emails) {
    const rc = ruleClassify(e.subject, e.raw_body);
    if (rc.isNoise) {
      await writeDigest(svc, e.id, {
        category: '噪音', summary: '(自动/退信/订阅,已归为噪音)', importance: 1,
        needs_action: false, action_type: '无',
      }, execFor(e), 'rule', now);
      noise++;
    } else {
      toAI.push({ id: e.id, subject: e.subject || '', body: e.raw_body || '', ruleCategory: rc.category });
    }
  }

  // Tier 1:Haiku 批量摘要(一批一调用)
  for (let i = 0; i < toAI.length; i += AI_BATCH) {
    const batch = toAI.slice(i, i + AI_BATCH);
    const ai = await summarizeBatch(batch);
    if (ai) {
      const byId = new Map(ai.map((a) => [a.id, a]));
      for (const b of batch) {
        const a = byId.get(b.id);
        const e = emails.find((x) => x.id === b.id);
        if (a) {
          await writeDigest(svc, b.id, a, execFor(e), 'haiku', now);
          aiDigested++;
        } else {
          // AI 漏了这封 → 用规则结果兜底,不留未归纳
          await writeDigest(svc, b.id, ruleFallbackOut(b), execFor(e), 'rule', now);
          ruleFallback++;
        }
      }
    } else {
      // 整批 AI 失败(超预算/超时)→ 全部规则兜底,标 digested 避免卡住队列
      for (const b of batch) {
        const e = emails.find((x) => x.id === b.id);
        await writeDigest(svc, b.id, ruleFallbackOut(b), execFor(e), 'rule', now);
        ruleFallback++;
      }
    }
  }

  return { scanned: emails.length, noise, aiDigested, ruleFallback };
}

function ruleFallbackOut(b: DigestInput): Omit<DigestOutput, 'id'> {
  const rc = ruleClassify(b.subject, b.body);
  return {
    category: rc.category, summary: (b.subject || '').slice(0, 60),
    importance: rc.importanceHint, needs_action: rc.importanceHint >= 2, action_type: '无',
  };
}

async function writeDigest(
  svc: any, id: string, d: Omit<DigestOutput, 'id'>,
  execId: string | null, tier: string, now: string,
): Promise<void> {
  try {
    await (svc.from('mail_inbox') as any).update({
      category: d.category, summary: d.summary, importance: d.importance,
      needs_action: d.needs_action, action_type: d.action_type,
      assigned_exec_id: execId, ai_tier: tier, digested_at: now,
    }).eq('id', id);
  } catch { /* 单封写失败不阻断整轮 */ }
}
