'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import type { CanonicalResponsibility } from '@/lib/domain/responsibility-model';
import { endResponsibility, getEffectiveResponsibilities, replaceResponsibility } from '@/lib/responsibility/service';

async function actor() {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) throw new Error('请先登录');
  const { data: profile } = await (session.from('profiles') as any).select('role,roles').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : [profile?.role].filter(Boolean);
  return { userId: user.id, roles };
}

export async function getOrderEffectiveResponsibilities(orderId: string) {
  try {
    await actor();
    return { data: await getEffectiveResponsibilities(createServiceRoleClient() as any, orderId) };
  } catch (error: any) { return { error: error?.message || '责任读取失败' }; }
}

export async function assignOrderResponsibility(input: {
  orderId: string; type: CanonicalResponsibility; userId: string; reason: string; sourceType?: 'handoff' | 'manual' | 'workflow'; sourceId?: string;
}) {
  try {
    const who = await actor();
    const db = createServiceRoleClient() as any;
    const data = await replaceResponsibility(db, who, input);
    await db.from('notifications').insert({
      user_id: input.userId, type: 'responsibility_assigned', title: '新的订单责任',
      message: `你已被指派为 ${input.type}，请进入对应工作台处理下一动作。`,
      related_order_id: input.orderId, status: 'unread', email_sent: false,
    });
    return { data };
  } catch (error: any) { return { error: error?.message || '责任指派失败' }; }
}

export async function closeOrderResponsibilities(orderId: string, reason: string) {
  try {
    const who = await actor();
    if (!who.roles.some((r) => ['order_manager', 'admin'].includes(r))) return { error: '仅业务执行经理或管理员可关闭订单责任' };
    const db = createServiceRoleClient() as any;
    const active = await getEffectiveResponsibilities(db, orderId);
    for (const row of active.filter((r) => r.source === 'explicit')) await endResponsibility(db, who, { orderId, type: row.type, reason });
    return { ok: true };
  } catch (error: any) { return { error: error?.message || '责任关闭失败' }; }
}

/** Compatibility hook: migration absence never bricks an existing workflow. */
export async function tryWriteOrderResponsibility(input: {
  orderId: string; type: CanonicalResponsibility; userId: string; reason: string; sourceType?: 'handoff' | 'manual' | 'workflow'; sourceId?: string;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const result = await assignOrderResponsibility(input);
  if (!result.error) return { ok: true };
  if (/order_responsibilities|replace_order_responsibility|schema cache|does not exist|PGRST/i.test(result.error)) return { ok: true, skipped: true };
  return { ok: false, error: result.error };
}
