'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

// ---- 订单号 / PO 号正则 ----
const ORDER_NO_RE = /QM-\d{8}-\d{3}/gi;
const PO_RE = /PO[\s#:_-]*[\w-]{3,}/gi;

export interface OrderMatch {
  order_id: string;
  order_no: string;
  customer_name: string | null;
  po_number: string | null;
  milestones: Array<{
    id: string;
    step_key: string;
    name: string;
    status: string;
    due_at: string | null;
  }>;
}

/**
 * 从文本中提取订单号/PO号/客户名，查库匹配，返回候选订单及其关卡。
 * 只读操作，不修改任何数据。
 */
export async function matchOrdersFromText(text: string): Promise<{ data: OrderMatch[]; error?: string }> {
  if (!text || text.trim().length < 5) return { data: [] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [], error: '未登录' };

  // 提取候选关键词
  const orderNos = [...new Set((text.match(ORDER_NO_RE) || []).map(s => s.toUpperCase()))];
  const poNumbers = [...new Set((text.match(PO_RE) || []).map(s => s.replace(/^PO[\s#:_-]*/i, '').trim()).filter(Boolean))];

  const matchedOrders = new Map<string, OrderMatch>();

  // 按订单号匹配
  if (orderNos.length > 0) {
    const { data: orders } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, po_number')
      .in('order_no', orderNos);
    for (const o of orders || []) {
      matchedOrders.set(o.id, { order_id: o.id, order_no: o.order_no, customer_name: o.customer_name, po_number: o.po_number, milestones: [] });
    }
  }

  // 按 PO 号匹配（补充没找到的）
  if (poNumbers.length > 0 && matchedOrders.size === 0) {
    for (const po of poNumbers) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, order_no, customer_name, po_number')
        .ilike('po_number', `%${po}%`)
        .limit(3);
      for (const o of orders || []) {
        if (!matchedOrders.has(o.id)) {
          matchedOrders.set(o.id, { order_id: o.id, order_no: o.order_no, customer_name: o.customer_name, po_number: o.po_number, milestones: [] });
        }
      }
    }
  }

  // 按客户名模糊匹配（仅在前面没匹配到时作为兜底）
  if (matchedOrders.size === 0) {
    const { data: customers } = await (supabase.from('customers') as any)
      .select('customer_name')
      .limit(200);
    const names = (customers || []).map((c: any) => c.customer_name as string).filter(Boolean);
    const textLower = text.toLowerCase();
    const matched = names.filter((n: string) => n.length >= 2 && textLower.includes(n.toLowerCase()));

    if (matched.length > 0 && matched.length <= 3) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, order_no, customer_name, po_number')
        .in('customer_name', matched)
        .order('created_at', { ascending: false })
        .limit(5);
      for (const o of orders || []) {
        matchedOrders.set(o.id, { order_id: o.id, order_no: o.order_no, customer_name: o.customer_name, po_number: o.po_number, milestones: [] });
      }
    }
  }

  if (matchedOrders.size === 0) return { data: [] };

  // 为匹配到的订单加载未完成的关卡
  const orderIds = [...matchedOrders.keys()];
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, name, status, due_at')
    .in('order_id', orderIds)
    .neq('status', 'done')
    .order('due_at', { ascending: true, nullsFirst: false });

  for (const m of milestones || []) {
    const order = matchedOrders.get(m.order_id);
    if (order) {
      order.milestones.push({
        id: m.id,
        step_key: m.step_key,
        name: m.name,
        status: m.status,
        due_at: m.due_at,
      });
    }
  }

  return { data: [...matchedOrders.values()] };
}

export async function createMemo(
  content: string,
  remindAt?: string,
  orderId?: string,
  milestoneId?: string,
  linkedOrderNo?: string,
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const payload: any = { user_id: user.id, content };
  if (remindAt) payload.remind_at = remindAt;
  if (orderId) payload.order_id = orderId;
  if (milestoneId) payload.milestone_id = milestoneId;
  if (linkedOrderNo) payload.linked_order_no = linkedOrderNo;

  const { error } = await supabase.from('user_memos').insert(payload);
  if (error) return { error: error.message };

  revalidatePath('/memos');
  revalidatePath('/my-today');
  return { success: true };
}

export async function toggleMemoDone(memoId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 先查当前状态
  const { data: memo } = await (supabase.from('user_memos') as any)
    .select('is_done')
    .eq('id', memoId)
    .eq('user_id', user.id)
    .single();

  if (!memo) return { error: '备忘不存在' };

  const { error } = await supabase
    .from('user_memos')
    .update({ is_done: !memo.is_done })
    .eq('id', memoId)
    .eq('user_id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/memos');
  revalidatePath('/my-today');
  return { success: true };
}

export async function deleteMemo(memoId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { error } = await supabase
    .from('user_memos')
    .delete()
    .eq('id', memoId)
    .eq('user_id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/memos');
  revalidatePath('/my-today');
  return { success: true };
}
