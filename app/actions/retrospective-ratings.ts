'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function saveRetrospectiveRatings(
  orderId: string,
  ratings: {
    customer_satisfaction: number | null;
    factory_rating: number | null;
    will_repeat_customer: boolean | null;
    will_repeat_factory: boolean | null;
  }
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');
  const isOwner = order.created_by === user.id || order.owner_user_id === user.id;
  if (!isAdmin && !isOwner) return { error: '仅订单负责人或管理员可操作' };

  // upsert：已有复盘则更新评分字段，无复盘则只写评分（不要求完整字段）
  const { data: existing } = await (supabase.from('order_retrospectives') as any)
    .select('id').eq('order_id', orderId).maybeSingle();

  if (existing) {
    const { error } = await (supabase.from('order_retrospectives') as any)
      .update({
        customer_satisfaction: ratings.customer_satisfaction,
        factory_rating: ratings.factory_rating,
        will_repeat_customer: ratings.will_repeat_customer,
        will_repeat_factory: ratings.will_repeat_factory,
      })
      .eq('order_id', orderId);
    if (error) return { error: error.message };
  } else {
    // 无完整复盘时，只插入评分部分（key_issue 等给占位符，等完整复盘再覆盖）
    const { error } = await (supabase.from('order_retrospectives') as any)
      .insert({
        order_id: orderId,
        owner_user_id: user.id,
        key_issue: '',
        root_cause: '',
        what_worked: '',
        improvement_actions: [],
        customer_satisfaction: ratings.customer_satisfaction,
        factory_rating: ratings.factory_rating,
        will_repeat_customer: ratings.will_repeat_customer,
        will_repeat_factory: ratings.will_repeat_factory,
      });
    if (error) return { error: error.message };
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}
