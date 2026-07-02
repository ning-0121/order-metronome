'use server';

/**
 * 订单逐款明细(order_line_items)存取 —— S1 富录入表。
 * 形状:styles[{ style_no, product_name, image_url, colors:[{color_cn,color_en,sizes:{S:qty},qty,remark}] }]
 * 与 createOrder 的 line_items 形状一致;喂生产任务单 / 客户 PI。整单替换(删旧插新)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/** 读订单明细 → 按款分组返回。 */
export async function getOrderLineItems(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('order_line_items') as any)
    .select('id, line_no, style_no, product_name, color_cn, color_en, sizes, qty_pcs, image_url, remark')
    .eq('order_id', orderId).order('line_no', { ascending: true });
  if (error) return { error: error.message };

  const map = new Map<string, any>();
  for (const r of (data || [])) {
    const key = `${r.style_no || ''}¦${r.product_name || ''}`;
    let st = map.get(key);
    if (!st) { st = { style_no: r.style_no || '', product_name: r.product_name || '', image_url: r.image_url || '', colors: [] }; map.set(key, st); }
    if (!st.image_url && r.image_url) st.image_url = r.image_url;
    st.colors.push({ color_cn: r.color_cn || '', color_en: r.color_en || '', sizes: r.sizes || {}, qty: Number(r.qty_pcs) || 0, remark: r.remark || '' });
  }
  return { data: [...map.values()] };
}

/** 整单替换订单明细(删旧插新)。权限:管理员/理单类角色/该单创建者·负责人。 */
export async function saveOrderLineItems(orderId: string, styles: any[]): Promise<{ ok?: boolean; styles?: number; lines?: number; total?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any).select('created_by, owner_user_id').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canEdit = roles.includes('admin')
    || (order as any).created_by === user.id
    || (order as any).owner_user_id === user.id
    || roles.some((r) => ['merchandiser', 'order_manager', 'sales_manager', 'admin_assistant'].includes(r));
  if (!canEdit) return { error: '无权编辑该订单明细(仅创建者/负责人/理单/管理员)' };

  // 组装行:每款每色一行,qty = Σsizes
  const rows: any[] = [];
  let lineNo = 0;
  for (const st of (styles || [])) {
    for (const c of (st?.colors || [])) {
      lineNo++;
      const sizesIn = c?.sizes || {};
      const sizes: Record<string, number> = {};
      let qty = 0;
      for (const [k, v] of Object.entries(sizesIn)) {
        const n = Number(v) || 0;
        if (n > 0) { sizes[k] = n; qty += n; }
      }
      rows.push({
        order_id: orderId, line_no: lineNo,
        style_no: st?.style_no?.trim() || null, product_name: st?.product_name?.trim() || null,
        color_cn: c?.color_cn?.trim() || null, color_en: c?.color_en?.trim() || null,
        sizes, unit: 'pcs', set_multiplier: 1,
        qty_pcs: qty || null, qty_raw: qty || null,
        image_url: st?.image_url?.trim() || null, remark: c?.remark?.trim() || null,
        source: 'manual',
      });
    }
  }

  const { error: delErr } = await (supabase.from('order_line_items') as any).delete().eq('order_id', orderId);
  if (delErr) return { error: '清旧明细失败:' + delErr.message };
  if (rows.length > 0) {
    const { error: insErr } = await (supabase.from('order_line_items') as any).insert(rows);
    if (insErr) return { error: '写明细失败:' + insErr.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, styles: (styles || []).length, lines: rows.length, total: rows.reduce((s, r) => s + (r.qty_pcs || 0), 0) };
}
