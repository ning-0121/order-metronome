'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { safeMutation } from '@/lib/db/safe-mutation';
import { revalidatePath } from 'next/cache';
import {
  INSPECTION_WAIVED_TAG,
  CAN_SET_INSPECTION_WAIVER,
  isInspectionWaived,
  roleAllowed,
} from '@/lib/domain/inspectionWaiver';

async function getRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  return (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
}

/**
 * 业务/QC 设置或取消「本单免验货」。
 * - 设置时必填原因(客户免验/内销小单/客户自验…),写进 order_logs 审计。
 * - 只改 special_tags(无迁移),放行门禁另在 markMilestoneDone。
 */
export async function setInspectionWaiver(orderId: string, waived: boolean, reason: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const roles = await getRoles(supabase, user.id);
  if (!roleAllowed(roles, CAN_SET_INSPECTION_WAIVER)) {
    return { error: '仅业务 / QC / 生产主管 / 管理员可标记本单免验货' };
  }
  if (waived && !reason?.trim()) {
    return { error: '请填写免验原因(如:客户免验 / 内销信任小单 / 客户自验不出报告)' };
  }

  const { data: order, error: readErr } = await (supabase.from('orders') as any)
    .select('special_tags, order_no').eq('id', orderId).single();
  if (readErr || !order) return { error: readErr?.message || '订单不存在' };

  const tags: string[] = Array.isArray(order.special_tags) ? order.special_tags : [];
  const already = isInspectionWaived(order);
  if (waived === already) return {};   // 无变化

  const next = waived
    ? [...tags, INSPECTION_WAIVED_TAG]
    : tags.filter((t) => t !== INSPECTION_WAIVED_TAG);

  // R1-C 策略 B:代码鉴权已过 → svc 写 + 断言。旧 session 写:QC 主管给别人建的单标免验
  // 被 RLS 滤 0 行且无 error —— 界面成功、tag 没写上、验货节点照卡(体检实锤)。
  const wWv = await safeMutation({ client: createServiceRoleClient(), table: 'orders', operation: 'update',
    payload: { special_tags: next, updated_at: new Date().toISOString() }, predicate: { id: orderId } });
  if (!wWv.ok) return { error: `免验标记未生效(${wWv.status}):${wWv.error}` };

  try {
    await (supabase.from('order_logs') as any).insert({
      order_id: orderId,
      actor_user_id: user.id,
      action: 'inspection_waiver',
      note: waived
        ? `标记「${INSPECTION_WAIVED_TAG}」:${reason.trim()}`
        : `取消「${INSPECTION_WAIVED_TAG}」(改为需正常验货报告)`,
      created_at: new Date().toISOString(),
    });
  } catch { /* 审计日志失败不阻断主流程 */ }

  revalidatePath(`/orders/${orderId}`);
  return {};
}
