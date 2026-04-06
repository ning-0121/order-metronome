'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';

/**
 * 批量分配：将指定角色的所有未分配节点分配给指定用户
 * 仅管理员可操作
 */
export async function batchAssignByRole(
  targetRole: string,
  targetUserId: string,
): Promise<{ error?: string; updated?: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可执行' };

  // 找所有未分配的该角色节点
  const { data: unassigned, error: queryErr } = await (supabase.from('milestones') as any)
    .select('id')
    .eq('owner_role', targetRole)
    .is('owner_user_id', null);

  if (queryErr) return { error: queryErr.message };
  if (!unassigned || unassigned.length === 0) return { updated: 0 };

  // 批量更新
  const ids = unassigned.map((m: any) => m.id);
  const { error: updateErr } = await (supabase.from('milestones') as any)
    .update({ owner_user_id: targetUserId })
    .in('id', ids);

  if (updateErr) return { error: updateErr.message };

  revalidatePath('/orders');
  revalidatePath('/dashboard');
  return { updated: ids.length };
}
