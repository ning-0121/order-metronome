'use server';

/**
 * 邮件归纳看板(Phase 2,2026-07-25 CEO 批)。读时零 AI —— 全部从 mail_inbox 已物化的归纳列拼装。
 * 业务执行看自己归属的邮件;管理/销售主管/admin 看全部。重点监控 = 高重点且未处理。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { CATEGORY_LABEL, type MailCategory } from '@/lib/email/classify';

export interface DigestRow {
  id: string;
  from_email: string;
  subject: string;
  summary: string | null;
  category: MailCategory | null;
  importance: number | null;
  needs_action: boolean | null;
  action_type: string | null;
  handled_status: string | null;
  received_at: string;
  order_id: string | null;
  order_no: string | null;
  customer_id: string | null;
}

export interface MailDigestView {
  scope: 'all' | 'mine';
  counts: { total: number; keyMonitor: number; needsAction: number; unhandled: number };
  keyMonitor: DigestRow[];                       // 重点监控:重点度3 且未处理,置顶
  byCategory: { category: MailCategory; label: string; rows: DigestRow[] }[];
  generatedAt: string;
  aiPending: number;                             // 还有多少封只走了规则(ai_tier='rule'),AI 摘要待补
}

const CATEGORY_ORDER: MailCategory[] = ['投诉', '交期', '样品', 'PO', '报价', '物流', '其他', '噪音'];

/** 拉取当前用户可见的邮件归纳(默认近 3 天已归纳、非噪音)。 */
export async function getMailDigest(days = 3): Promise<{ data?: MailDigestView; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const seeAll = hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS');

  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, summary, category, importance, needs_action, action_type, handled_status, received_at, order_id, customer_id, ai_tier')
    .not('digested_at', 'is', null)
    .neq('category', '噪音')
    .gte('received_at', since)
    .order('importance', { ascending: false })
    .order('received_at', { ascending: false })
    .limit(400);
  if (!seeAll) q = q.eq('assigned_exec_id', user.id);   // 业务执行只看自己归属的

  const { data: rows, error } = await q;
  if (error) return { error: error.message };
  const list = (rows || []) as DigestRow[];

  // 富化订单号(有 order_id 的批量查)
  const orderIds = [...new Set(list.map((r) => r.order_id).filter(Boolean))] as string[];
  if (orderIds.length > 0) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, internal_order_no, order_no').in('id', orderIds);
    const noMap = new Map((ords || []).map((o: any) => [o.id, o.internal_order_no || o.order_no]));
    for (const r of list) if (r.order_id) r.order_no = (noMap.get(r.order_id) as string) || null;
  }

  const unhandled = (r: DigestRow) => r.handled_status === 'unread' || r.handled_status === 'seen' || !r.handled_status;
  const keyMonitor = list.filter((r) => (r.importance ?? 0) >= 3 && unhandled(r));
  const keyIds = new Set(keyMonitor.map((r) => r.id));

  const byCategory = CATEGORY_ORDER
    .map((cat) => ({
      category: cat, label: CATEGORY_LABEL[cat],
      rows: list.filter((r) => r.category === cat && !keyIds.has(r.id)),
    }))
    .filter((g) => g.rows.length > 0);

  const aiPending = list.filter((r) => (r as any).ai_tier === 'rule').length;

  return {
    data: {
      scope: seeAll ? 'all' : 'mine',
      counts: {
        total: list.length,
        keyMonitor: keyMonitor.length,
        needsAction: list.filter((r) => r.needs_action && unhandled(r)).length,
        unhandled: list.filter(unhandled).length,
      },
      keyMonitor,
      byCategory,
      generatedAt: new Date().toISOString(),
      aiPending,
    },
  };
}

/** 某订单的客户邮件信号(投诉/交期/样品,闭环 P3b)。订单页展示。 */
export async function getOrderMailSignals(orderId: string): Promise<{ data?: DigestRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!orderId) return { data: [] };
  const { data, error } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, summary, category, importance, needs_action, action_type, handled_status, received_at, order_id, customer_id')
    .eq('order_id', orderId)
    .in('category', ['投诉', '交期', '样品'])
    .not('digested_at', 'is', null)
    .order('importance', { ascending: false })
    .order('received_at', { ascending: false })
    .limit(30);
  if (error) return { error: error.message };
  return { data: (data || []) as DigestRow[] };
}

export interface POAttachmentRow {
  id: string; file_name: string | null; extract_summary: string | null;
  extracted_json: any; ocr_status: string | null;
}

/** 某订单的 PO 附件 OCR 要点(闭环 T2b)。订单页展示。 */
export async function getOrderPOAttachments(orderId: string): Promise<{ data?: POAttachmentRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!orderId) return { data: [] };
  const { data, error } = await (supabase.from('mail_attachments') as any)
    .select('id, file_name, extract_summary, extracted_json, ocr_status')
    .eq('order_id', orderId).eq('is_po', true)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return { error: error.message };
  return { data: (data || []) as POAttachmentRow[] };
}

/** 标记一封邮件的处理状态(看板勾选)。 */
export async function markMailHandled(
  id: string, status: 'seen' | 'handled' | 'ignored' | 'unread',
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!['seen', 'handled', 'ignored', 'unread'].includes(status)) return { error: '非法状态' };
  // mail_inbox 原迁移只有 SELECT/INSERT 策略、无 UPDATE 策略 → user-session 更新会静默命中 0 行(qc_inspections 教训)。
  // 已鉴权用户 → 经 service-role 写,并用 .select() 确认真改了行。
  const { data: updated, error } = await (createServiceRoleClient().from('mail_inbox') as any)
    .update({ handled_status: status }).eq('id', id).select('id');
  if (error) return { error: error.message };
  if (!updated || updated.length === 0) return { error: '标记失败:邮件不存在' };
  return { ok: true };
}
