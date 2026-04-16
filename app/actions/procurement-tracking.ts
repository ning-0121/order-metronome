'use server';

/**
 * 采购进度共享表 — 实时协作
 *
 * 所有角色可查看，采购/业务/跟单/管理员可编辑
 * 每个订单一张采购跟踪表，包含面料/辅料/包装等所有采购项
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface ProcurementItem {
  id: string;
  order_id: string;
  category: string;        // fabric/trims/packaging/other
  item_name: string;       // 面料名/辅料名
  supplier: string | null; // 供应商
  quantity: string | null;  // 数量
  order_date: string | null;       // 下单日期
  expected_arrival: string | null; // 预计到货
  actual_arrival: string | null;   // 实际到货
  status: string;          // pending/ordered/in_transit/arrived/problem
  notes: string | null;
  updated_by_name: string | null;
  updated_at: string;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  fabric: '面料',
  trims: '辅料',
  packaging: '包装材料',
  other: '其他',
};

/**
 * 获取订单的采购跟踪列表
 */
export async function getProcurementItems(orderId: string): Promise<{
  data?: ProcurementItem[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('procurement_tracking') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });

  if (error) return { error: error.message };
  return { data: data || [] };
}

/**
 * 添加采购项
 */
export async function addProcurementItem(
  orderId: string,
  item: {
    category: string;
    item_name: string;
    supplier?: string;
    quantity?: string;
    order_date?: string;
    expected_arrival?: string;
    notes?: string;
  }
): Promise<{ error?: string; id?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取用户名
  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  const { data, error } = await (supabase.from('procurement_tracking') as any)
    .insert({
      order_id: orderId,
      category: item.category || 'other',
      item_name: item.item_name,
      supplier: item.supplier || null,
      quantity: item.quantity || null,
      order_date: item.order_date || null,
      expected_arrival: item.expected_arrival || null,
      status: 'pending',
      notes: item.notes || null,
      updated_by: user.id,
      updated_by_name: userName,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { id: (data as any)?.id };
}

/**
 * 更新采购项（任何可编辑字段）
 */
export async function updateProcurementItem(
  itemId: string,
  updates: {
    item_name?: string;
    supplier?: string;
    quantity?: string;
    order_date?: string | null;
    expected_arrival?: string | null;
    actual_arrival?: string | null;
    status?: string;
    notes?: string;
  }
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  const { error } = await (supabase.from('procurement_tracking') as any)
    .update({
      ...updates,
      updated_by: user.id,
      updated_by_name: userName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { error: error.message };

  // 获取 order_id 用于 revalidate
  const { data: item } = await (supabase.from('procurement_tracking') as any)
    .select('order_id').eq('id', itemId).single();
  if (item) revalidatePath(`/orders/${(item as any).order_id}`);
  return {};
}

/**
 * 删除采购项
 */
export async function deleteProcurementItem(itemId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: item } = await (supabase.from('procurement_tracking') as any)
    .select('order_id').eq('id', itemId).single();

  const { error } = await (supabase.from('procurement_tracking') as any)
    .delete().eq('id', itemId);

  if (error) return { error: error.message };
  if (item) revalidatePath(`/orders/${(item as any).order_id}`);
  return {};
}

/**
 * 快速初始化：为订单创建默认采购项（面料+辅料+包装）
 */
export async function initDefaultProcurementItems(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || '';

  // 检查是否已有数据
  const { data: existing } = await (supabase.from('procurement_tracking') as any)
    .select('id').eq('order_id', orderId).limit(1);
  if (existing && existing.length > 0) return {}; // 已初始化

  const defaults = [
    { category: 'fabric', item_name: '大货面料', status: 'pending' },
    { category: 'trims', item_name: '拉链/纽扣', status: 'pending' },
    { category: 'trims', item_name: '吊牌/洗标', status: 'pending' },
    { category: 'packaging', item_name: '包装袋/纸箱', status: 'pending' },
  ];

  for (const d of defaults) {
    await (supabase.from('procurement_tracking') as any).insert({
      order_id: orderId,
      ...d,
      updated_by: user.id,
      updated_by_name: userName,
    });
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}
