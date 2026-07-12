'use server';

/**
 * araos PO → 一键建单。开发系统(araos)确认 PO 后，把全量 PO 数据 + PO 原件 URL 推到
 * araos_handoffs_inbox。本动作把一条 inbox PO 映射成 createOrder 的 FormData（客户/款色码/
 * 数量/PO号 预填），业务补运营字段（内部单号/贸易条款/订单类型/工厂期）→ 复用既有 createOrder
 * 管线建单（正确打里程碑）。建成后回写 inbox.converted_order_id。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';

const CAN_CREATE_ORDER = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

// 角色审计修:araos_handoffs_inbox 的迁移 ENABLE RLS 但**无任何策略**(设计本意「只 service-role 读写」),
//   而本文件用 user-session 读 → 默认全拒、列表恒空、一键建单整条死掉。改:角色门禁仍用 user-session 校验,
//   inbox 的读写走 service-role(svc)绕过无策略 RLS。
async function authed() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, svc: supabase, ok: false as const };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  let svc: any = supabase;
  try { svc = createServiceRoleClient(); } catch { /* 降级 user-session */ }
  return { supabase, svc, ok: roles.some((r) => CAN_CREATE_ORDER.includes(r)) };
}

export interface AraosPO {
  id: string;
  araosOrderId: string;
  customerId: string | null;
  customerName: string;
  poNumber: string;
  poFileUrl: string;
  quantity: number | null;
  requiredDelivery: string;
  brandRequirements: string;
  contactName: string;
  productLines: Array<{ style?: string; qty?: number; unit_price?: number }>;
  receivedAt: string;
}

function extract(row: any): AraosPO {
  const p = row?.payload?.data ?? row?.payload ?? {};
  return {
    id: row.id,
    araosOrderId: row.araos_order_id,
    customerId: row.qimo_customer_id ?? null,
    customerName: p.company_name ?? p.customer?.company_name ?? '',
    poNumber: p.po_number ?? p.deal?.po_number ?? '',
    poFileUrl: p.po_file_url ?? '',
    quantity: p.quantity ?? null,
    requiredDelivery: p.required_delivery ?? '',
    brandRequirements: p.brand_requirements ?? '',
    contactName: p.contact_name ?? '',
    productLines: Array.isArray(p.product_lines) ? p.product_lines : [],
    receivedAt: row.received_at,
  };
}

/** 待建单：未转成订单、且为订单型的 araos PO。 */
export async function listPendingAraosPOs(): Promise<AraosPO[]> {
  const { svc, ok } = await authed();
  if (!ok) return [];
  // 优先按 converted_order_id 过滤；列未迁移时降级为按 status 过滤，避免报错。
  let data: any[] | null = null;
  const q = await (svc.from('araos_handoffs_inbox') as any)
    .select('*').is('converted_order_id', null).neq('status', 'error')
    .order('received_at', { ascending: false }).limit(50);
  if (q.error) {
    const q2 = await (svc.from('araos_handoffs_inbox') as any)
      .select('*').neq('status', 'error').neq('status', 'converted')
      .order('received_at', { ascending: false }).limit(50);
    data = q2.data;
  } else {
    data = q.data;
  }
  return (data ?? [])
    .filter((r: any) => {
      const p = r?.payload?.data ?? r?.payload ?? {};
      return p.type === 'production_order' || r.event_type === 'deal_won' || r?.payload?.entity_type === 'order';
    })
    .map(extract);
}

/** 一键建单：映射 araos PO + 业务补运营字段 → createOrder。 */
export async function buildOrderFromAraosPO(formData: FormData): Promise<void> {
  const { svc, ok } = await authed();
  const back = (err: string) => redirect(`/orders/from-araos?error=${encodeURIComponent(err)}`);
  if (!ok) return back('无建单权限');

  const inboxId = formData.get('inboxId') as string;
  if (!inboxId) return back('缺少 inboxId');
  const { data: row } = await (svc.from('araos_handoffs_inbox') as any).select('*').eq('id', inboxId).maybeSingle();
  if (!row) return back('PO 不存在');
  if (row.converted_order_id) return back('该 PO 已建单');
  const po = extract(row);
  if (!po.customerId) return back('该 PO 未匹配到客户，请先在客户库确认客户');

  const lineItems = (po.productLines.length ? po.productLines : [{ style: po.poNumber || '款式1', qty: po.quantity ?? 0 }]).map((l) => ({
    style_no: l.style ?? null,
    product_name: l.style ?? null,
    colors: [{ color_cn: null, color_en: null, sizes: {}, qty: Number(l.qty ?? 0) || 0 }],
  }));
  const totalQty = po.productLines.reduce((s, l) => s + (Number(l.qty) || 0), 0) || po.quantity || 0;

  const fd = new FormData();
  fd.set('customer_id', po.customerId);
  fd.set('customer_name', po.customerName);
  fd.set('customer_po_number', (formData.get('po_number') as string) || po.poNumber || '');
  fd.set('line_items', JSON.stringify(lineItems));
  fd.set('total_quantity', String((formData.get('total_quantity') as string) || totalQty));
  fd.set('quantity_unit', '件');
  fd.set('style_count', String(lineItems.length || 1));
  fd.set('color_count', (formData.get('color_count') as string) || String(lineItems.length || 1));
  fd.set('incoterm', (formData.get('incoterm') as string) || 'FOB');
  fd.set('order_type', (formData.get('order_type') as string) || 'bulk');
  fd.set('internal_order_no', ((formData.get('internal_order_no') as string) || '').trim());
  const factoryDate = formData.get('factory_date') as string;
  if (factoryDate) fd.set('factory_date', factoryDate);
  if (po.requiredDelivery) fd.set('warehouse_due_date', po.requiredDelivery);

  const pre = await preGenerateOrderNo();
  if (!('orderNo' in pre) || !pre.orderNo) return back('订单号生成失败');
  const res = await createOrder(fd, pre.orderNo);
  if (!res.ok || !res.orderId) return back(res.error || '建单失败');

  await (svc.from('araos_handoffs_inbox') as any)
    .update({ converted_order_id: res.orderId, status: 'converted', processed_at: new Date().toISOString() })
    .eq('id', inboxId);
  revalidatePath('/orders/from-araos');
  revalidatePath('/orders');
  redirect(`/orders/${res.orderId}`);
}
