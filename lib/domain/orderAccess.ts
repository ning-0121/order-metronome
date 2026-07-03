/**
 * 订单级访问控制(可复用)—— 从 getOrder 的内联逻辑抽出。
 *
 * 用于:当某个读取要绕过 RLS(改走 service-role,如剥离底价列后)时,必须在
 * app 层显式补回订单范围鉴权,否则会引入跨订单越权。
 *
 * 放行:看全部订单的角色(admin/CAN_SEE_ALL_ORDERS) / 创建者 / 跟单负责人 /
 *       被指派了该单里程碑的人。判定异常保守拒绝(安全侧)。
 */

import { getUserRoles } from '@/lib/utils/user-role';
import { hasRoleInGroup } from '@/lib/domain/roles';

/**
 * 该用户能否访问该订单。用 **用户会话** 客户端调用(读 profiles/orders 受 RLS,
 * 读不到订单 → 判为无权,fail-safe)。
 */
export async function canUserAccessOrder(
  supabase: any,
  userId: string,
  orderId: string,
): Promise<boolean> {
  try {
    const roles = await getUserRoles(supabase, userId);
    if (roles.includes('admin') || hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS')) return true;

    const { data: order } = await (supabase.from('orders') as any)
      .select('created_by, owner_user_id').eq('id', orderId).maybeSingle();
    if (order && ((order as any).created_by === userId || (order as any).owner_user_id === userId)) return true;

    const { data: ms } = await (supabase.from('milestones') as any)
      .select('id').eq('order_id', orderId).eq('owner_user_id', userId).limit(1);
    return (ms || []).length > 0;
  } catch {
    return false; // 鉴权查询异常 → 安全侧拒绝
  }
}
