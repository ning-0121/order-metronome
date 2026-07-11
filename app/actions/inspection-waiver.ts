'use server';

import { createClient } from '@/lib/supabase/server';
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

  const { error: upErr } = await (supabase.from('orders') as any)
    .update({ special_tags: next, updated_at: new Date().toISOString() }).eq('id', orderId);
  if (upErr) return { error: upErr.message };

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
