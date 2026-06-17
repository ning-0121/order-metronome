'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { friendlyError } from '@/lib/utils/db-error';

export interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  roles: string[];
  active?: boolean;
}

/**
 * 用户列表。
 * 默认仅返回在职用户（active !== false）—— 指派人选择器(OwnerAssignment 等)直接用，
 * 离职者不会再出现在任何下拉。传 includeInactive=true 才返回全部（如 admin 用户管理页）。
 *
 * 容错：若 active 列尚未迁移（20260617_profiles_active_offboarding.sql 未执行），
 * 自动降级到不含 active 的查询，全部视为在职，避免列不存在导致用户列表白屏。
 */
export async function getAllUsers(
  opts?: { includeInactive?: boolean }
): Promise<{ data: User[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Unauthorized' };
  }

  let { data: profiles, error } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, role, roles, active')
    .order('email', { ascending: true });

  // 降级：迁移尚未执行（无 active 列）时退回旧查询
  if (error && /active|column|does not exist/i.test(error.message || '')) {
    ({ data: profiles, error } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role, roles')
      .order('email', { ascending: true }));
  }

  if (error) {
    return { data: null, error: friendlyError(error, '加载用户列表失败') };
  }

  const includeInactive = opts?.includeInactive === true;
  const mapped: User[] = (profiles || [])
    .map((p: any) => ({
      user_id: p.user_id,
      email: p.email || '',
      full_name: p.name ?? p.email ?? null,
      role: p.role || null,
      roles: p.roles || [],
      active: p.active !== false, // 缺列时默认在职
    }))
    .filter((u: User) => includeInactive || u.active !== false);

  return { data: mapped, error: null };
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
    return { error: friendlyError(error, '更新用户角色失败') };
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
 * 离职办理（推荐路径，替代硬删除）—— 仅管理员
 * 一键完成三件事，杜绝漏步（尤其封号）：
 *   1) 转派活跃工作：未完成节点 owner + 活跃订单 owner → 接手人（已完成/取消保留原 owner 作历史）
 *   2) 封锁登录：ban auth 账号（保留行与全部历史、可逆）—— 关键！否则离职者仍能登录
 *   3) 移出花名册：profiles.active=false（软停用，保留 name 让历史节点仍显示姓名）
 * 二次确认：confirmName 必须与离职者姓名一致。
 * 详见 docs/offboarding-sop.md。
 */
export async function offboardUser(
  targetUserId: string,
  handoverToUserId: string,
  confirmName: string,
): Promise<{ error?: string; success?: boolean; reassignedMilestones?: number; reassignedOrders?: number }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限：仅管理员可办理离职' };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (user.id === targetUserId) return { error: '不能给自己办理离职' };
  if (!handoverToUserId) return { error: '请选择接手人' };
  if (handoverToUserId === targetUserId) return { error: '接手人不能是离职者本人' };

  // 取离职者 + 接手人档案
  const { data: target } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, active')
    .eq('user_id', targetUserId)
    .single();
  if (!target) return { error: '离职员工不存在' };
  if ((target as any).active === false) return { error: '该员工已是离职状态' };

  const { data: handover } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, active')
    .eq('user_id', handoverToUserId)
    .single();
  if (!handover) return { error: '接手人不存在' };
  if ((handover as any).active === false) return { error: '接手人已离职，无法作为接手人' };

  // 二次确认：输入姓名须与离职者一致（无 name 时回退邮箱）
  const expected = ((target as any).name || (target as any).email || '').trim();
  if (!confirmName || confirmName.trim() !== expected) {
    return { error: `二次确认失败：请输入离职员工的姓名「${expected}」` };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: '系统配置错误：缺少 SUPABASE_SERVICE_ROLE_KEY' };
  }

  try {
    const admin = createSupabaseClient(url, serviceKey);

    // 1) 转派未完成节点 → 接手人（actual_at is null = 未完成）
    const { data: msRows, error: msErr } = await (admin.from('milestones') as any)
      .update({ owner_user_id: handoverToUserId, updated_at: new Date().toISOString() })
      .eq('owner_user_id', targetUserId)
      .is('actual_at', null)
      .select('id');
    if (msErr) return { error: '转派节点失败：' + msErr.message };
    const reassignedMilestones = (msRows || []).length;

    // 2) 转派活跃订单 owner → 接手人（已完成/取消/归档保留原 owner 作历史）
    const { data: ordRows, error: ordErr } = await (admin.from('orders') as any)
      .update({ owner_user_id: handoverToUserId })
      .eq('owner_user_id', targetUserId)
      .not('lifecycle_status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")')
      .select('id');
    if (ordErr) return { error: '转派订单失败：' + ordErr.message };
    const reassignedOrders = (ordRows || []).length;

    // 3) 封锁登录（关键）：ban auth，保留行与历史、可逆（~100 年）
    const { error: banErr } = await admin.auth.admin.updateUserById(targetUserId, {
      ban_duration: '876000h',
    });
    if (banErr) return { error: '封锁登录失败：' + banErr.message };

    // 4) 移出花名册（软停用）
    const { error: profErr } = await (admin.from('profiles') as any)
      .update({
        active: false,
        departed_at: new Date().toISOString(),
        handover_to: handoverToUserId,
      })
      .eq('user_id', targetUserId);
    if (profErr) return { error: '停用档案失败：' + profErr.message };

    return { success: true, reassignedMilestones, reassignedOrders };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: '离职办理失败：' + message };
  }
}

/**
 * 恢复在职（离职误操作 / 返聘）—— 仅管理员
 * 解封 auth + active=true。不会自动把转派出去的工作收回（需手动再指派）。
 */
export async function reactivateUser(
  targetUserId: string,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限：仅管理员可恢复在职' };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: '系统配置错误：缺少 SUPABASE_SERVICE_ROLE_KEY' };
  }

  try {
    const admin = createSupabaseClient(url, serviceKey);

    // 解封登录
    const { error: banErr } = await admin.auth.admin.updateUserById(targetUserId, {
      ban_duration: 'none',
    });
    if (banErr) return { error: '解封登录失败：' + banErr.message };

    const { error: profErr } = await (admin.from('profiles') as any)
      .update({ active: true, departed_at: null })
      .eq('user_id', targetUserId);
    if (profErr) return { error: '恢复档案失败：' + profErr.message };

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
