'use server';

/**
 * 客户强调事项(2026-07-27 CEO:表单精简了,但客户 PO/邮件里强调的内容要冒出来并标来源)。
 * 聚合两处 → 每条带来源标签「PO强调 / 邮件强调」,给节点报告表单置顶,防漏客户要求。
 *   - PO强调:document_extractions(PO 提取)的 品质要求/生产注意/特殊说明/包装要求。
 *   - 邮件强调:mail_inbox(邮件归纳)本单 重点度≥2 的非噪音邮件摘要。
 * 只读;纯要求文本、无底价,登录+可访问订单即可看。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export interface EmphasisItem { source: 'PO强调' | '邮件强调'; kind: string; text: string; }

export async function getOrderEmphasis(orderId: string): Promise<{ data?: EmphasisItem[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!orderId) return { data: [] };
  const { canUserAccessOrder } = await import('@/lib/domain/orderAccess');
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };

  const svc = createServiceRoleClient();
  const items: EmphasisItem[] = [];

  // ── PO 强调:最新一条 PO 提取 ──
  try {
    const { data: ext } = await (svc.from('document_extractions') as any)
      .select('extracted_json, created_at').eq('order_id', orderId).eq('doc_category', 'customer_po')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const j = (ext as any)?.extracted_json;
    if (j) {
      for (const q of (j.quality_requirements || [])) if (String(q).trim()) items.push({ source: 'PO强调', kind: '品质', text: String(q).trim() });
      for (const p of (j.production_notes || [])) if (String(p).trim()) items.push({ source: 'PO强调', kind: '生产', text: String(p).trim() });
      if (j.special_instructions && String(j.special_instructions).trim()) items.push({ source: 'PO强调', kind: '特殊', text: String(j.special_instructions).trim() });
      const pk = j.packaging_requirements || {};
      for (const [k, v] of Object.entries(pk)) if (v && String(v).trim()) items.push({ source: 'PO强调', kind: '包装', text: `${String(v).trim()}` });
    }
  } catch { /* 无 PO 提取跳过 */ }

  // ── 邮件强调:本单重点邮件摘要 ──
  try {
    const { data: mails } = await (svc.from('mail_inbox') as any)
      .select('summary, subject, category, importance').eq('order_id', orderId)
      .not('digested_at', 'is', null).neq('category', '噪音').gte('importance', 2)
      .order('importance', { ascending: false }).order('received_at', { ascending: false }).limit(10);
    for (const m of (mails || [])) {
      const t = (m.summary || m.subject || '').trim();
      if (t) items.push({ source: '邮件强调', kind: m.category || '邮件', text: t });
    }
  } catch { /* 无邮件归纳跳过 */ }

  return { data: items };
}
