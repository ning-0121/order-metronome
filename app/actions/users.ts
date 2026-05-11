'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  roles: string[];
}

export async function getAllUsers(): Promise<{ data: User[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Unauthorized' };
  }

  const { data: profiles, error } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, role, roles')
    .order('email', { ascending: true });

  if (error) {
    return { data: null, error: error.message };
  }

  return {
    data: (profiles || []).map((p: any) => ({
      user_id: p.user_id,
      email: p.email || '',
      full_name: p.name ?? p.email ?? null,
      role: p.role || null,
      roles: p.roles || [],
    })),
    error: null,
  };
}

/**
 * 更新用户角色（仅管理员可操作）
 */
export async function updateUserRoles(
  targetUserId: string,
  newRoles: string[],
  newName?: string,
  wechatPushKey?: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);

  if (!isAdmin) {
    return { error: '无权限：仅管理员可修改用户角色' };
  }

  const updateData: any = {
    roles: newRoles,
    role: newRoles[0] || 'sales',
  };

  if (newName !== undefined) {
    updateData.name = newName;
  }

  if (wechatPushKey !== undefined) {
    updateData.wechat_push_key = wechatPushKey || null;
  }

  const { error } = await (supabase.from('profiles') as any)
    .update(updateData)
    .eq('user_id', targetUserId);

  if (error) {
    return { error: error.message };
  }

  return { error: null };
}

/**
 * 预检：用户是否可以被删除？
 * 返回进行中的节点 + 活动订单数；调用方据此决定是否允许删除。
 */
export async function checkUserDeletable(targetUserId: string): Promise<{
  error?: string;
  canDelete?: boolean;
  activeMilestones?: { id: string; name: string; order_no: string; status: string }[];
  ownedOrders?: { id: string; order_no: string; customer_name: string }[];
}> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限：仅管理员可删除用户' };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (user.id === targetUserId) return { error: '不能删除自己' };

  // 查找该用户负责、且未完成的节点
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('id, name, status, orders!inner(order_no)')
    .eq('owner_user_id', targetUserId)
    .not('status', 'in', '("done","已完成","completed")')
    .limit(50);
  const activeMilestones = ((ms || []) as any[]).map((m: any) => ({
    id: m.id,
    name: m.name,
    order_no: m.orders?.order_no || '',
    status: m.status,
  }));

  // 查找该用户作为跟单/创建者、且订单未归档的订单
  const { data: ownedRaw } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, lifecycle_status, created_by, owner_user_id')
    .or(`created_by.eq.${targetUserId},owner_user_id.eq.${targetUserId}`)
    .not('lifecycle_status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")')
    .limit(50);
  const ownedOrders = ((ownedRaw || []) as any[]).map((o: any) => ({
    id: o.id,
    order_no: o.order_no,
    customer_name: o.customer_name,
  }));

  return {
    canDelete: activeMilestones.length === 0 && ownedOrders.length === 0,
    activeMilestones,
    ownedOrders,
  };
}

/**
 * 管理员删除员工（硬删除 auth.users + profiles）
 * 安全措施：
 * 1. 仅 admin
 * 2. 不能删自己
 * 3. 必须通过 checkUserDeletable 预检
 * 4. 必须提供 confirmEmail 且与目标用户邮箱一致
 */
export async function deleteUser(
  targetUserId: string,
  confirmEmail: string,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限：仅管理员可删除用户' };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (user.id === targetUserId) return { error: '不能删除自己' };

  // 取目标用户邮箱用于二次校验
  const { data: targetProfile } = await (supabase.from('profiles') as any)
    .select('email, name')
    .eq('user_id', targetUserId)
    .single();
  if (!targetProfile) return { error: '员工不存在' };

  if (!confirmEmail || confirmEmail.trim().toLowerCase() !== (targetProfile as any).email?.toLowerCase()) {
    return { error: '二次确认失败：请输入与该员工邮箱一致的内容' };
  }

  // 二次预检（防止 UI 和后端状态不一致）
  const precheck = await checkUserDeletable(targetUserId);
  if (precheck.error) return { error: precheck.error };
  if (!precheck.canDelete) {
    return {
      error: `该员工仍有进行中的工作：${precheck.activeMilestones?.length || 0} 个节点 / ${precheck.ownedOrders?.length || 0} 个订单。请先改派后再删除。`,
    };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: '系统配置错误：缺少 SUPABASE_SERVICE_ROLE_KEY' };
  }

  try {
    const adminClient = createSupabaseClient(url, serviceKey);
    // 先删 profile 行，再删 auth 用户
    const { error: profErr } = await (adminClient.from('profiles') as any)
      .delete()
      .eq('user_id', targetUserId);
    if (profErr) {
      return { error: '删除 profile 失败：' + profErr.message };
    }
    const { error: authErr } = await adminClient.auth.admin.deleteUser(targetUserId);
    if (authErr) {
      return { error: '删除 auth 用户失败：' + authErr.message };
    }
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: '操作失败：' + message };
  }
}

/**
 * 管理员直接重置用户密码（service_role admin API）
 */
export async function adminResetPassword(
  targetUserId: string,
  newPassword: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);

  if (!isAdmin) {
    return { error: '无权限：仅管理员可重置密码' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { error: '密码至少 6 位' };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: '系统配置错误：缺少 SUPABASE_SERVICE_ROLE_KEY' };
  }

  try {
    const adminClient = createSupabaseClient(url, serviceKey);
    const { error } = await adminClient.auth.admin.updateUserById(targetUserId, {
      password: newPassword,
    });

    if (error) {
      return { error: '重置失败：' + error.message };
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: '操作失败：' + message };
  }
}
