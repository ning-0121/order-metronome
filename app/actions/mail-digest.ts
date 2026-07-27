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
  customer_name: string | null;   // 客户名(绑定订单带出;无单则取邮件匹配客户),2026-07-27 CEO
  owner_name: string | null;      // 业务执行负责人(邮件 assigned_exec_id 优先,回退订单 owner)
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
    .select('id, from_email, subject, summary, category, importance, needs_action, action_type, handled_status, received_at, order_id, customer_id, assigned_exec_id, ai_tier')
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

  // 富化订单号 + 客户名 + 业务执行负责人(有 order_id 的批量查;负责人优先取邮件 assigned_exec_id)
  const orderIds = [...new Set(list.map((r) => r.order_id).filter(Boolean))] as string[];
  const noMap = new Map<string, string>(), custMap = new Map<string, string>(), orderOwnerMap = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, internal_order_no, order_no, customer_name, owner_user_id').in('id', orderIds);
    for (const o of ((ords || []) as any[])) {
      noMap.set(o.id, o.internal_order_no || o.order_no);
      if (o.customer_name) custMap.set(o.id, o.customer_name);
      if (o.owner_user_id) orderOwnerMap.set(o.id, o.owner_user_id);
    }
  }
  // 解析负责人名:邮件 assigned_exec_id 优先,回退订单 owner_user_id
  const ownerIdByRow = new Map<string, string>();
  for (const r of list) {
    const oid = (r as any).assigned_exec_id || (r.order_id ? orderOwnerMap.get(r.order_id) : null);
    if (oid) ownerIdByRow.set(r.id, oid);
  }
  const nameById = new Map<string, string>();
  const ownerIds = [...new Set([...ownerIdByRow.values()])];
  if (ownerIds.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name, email').in('user_id', ownerIds);
    for (const p of ((profs || []) as any[])) nameById.set(p.user_id, p.name || (p.email ? String(p.email).split('@')[0] : ''));
  }
  for (const r of list) {
    if (r.order_id) { r.order_no = noMap.get(r.order_id) || null; r.customer_name = custMap.get(r.order_id) || null; }
    const oid = ownerIdByRow.get(r.id);
    r.owner_name = oid ? (nameById.get(oid) || null) : null;
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

/** 搜订单给「绑定到订单」下拉(按内部单号/客户/PO号/款号 ilike)。 */
export async function searchOrdersForMailBind(q: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const term = (q || '').trim();
  let query = (supabase.from('orders') as any)
    .select('id, internal_order_no, order_no, po_number, customer_name, style_no, owner_user_id, created_by')
    .order('created_at', { ascending: false }).limit(20);
  if (term) query = query.or(`internal_order_no.ilike.%${term}%,order_no.ilike.%${term}%,po_number.ilike.%${term}%,customer_name.ilike.%${term}%,style_no.ilike.%${term}%`);
  const { data } = await query;
  return ((data || []) as any[]).map((o) => ({
    id: o.id,
    label: [o.internal_order_no || o.order_no, o.po_number ? `PO ${o.po_number}` : null, o.customer_name, o.style_no].filter(Boolean).join(' · '),
  }));
}

/**
 * 手动把一封邮件绑定到订单(防漏防错核心:自动没匹配上的客户沟通,人工挂到目标 PO)。
 * 设 order_id + 归属业务执行(订单负责人)→ 立刻出现在该订单「客户邮件信号」面板 + 该负责人看板。
 */
export async function bindMailToOrder(mailId: string, orderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!mailId || !orderId) return { error: '缺少参数' };
  const svc = createServiceRoleClient();
  // 取订单负责人(带出归属),顺带校验订单存在
  const { data: ord } = await (svc.from('orders') as any)
    .select('id, owner_user_id, created_by').eq('id', orderId).maybeSingle();
  if (!ord) return { error: '订单不存在' };
  const execId = (ord as any).owner_user_id || (ord as any).created_by || null;
  const { data: updated, error } = await (svc.from('mail_inbox') as any)
    .update({ order_id: orderId, assigned_exec_id: execId }).eq('id', mailId).select('id');
  if (error) return { error: error.message };
  if (!updated || updated.length === 0) return { error: '绑定失败:邮件不存在' };
  return { ok: true };
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
