'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function createMemo(content: string, remindAt?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const payload: any = { user_id: user.id, content };
  if (remindAt) payload.remind_at = remindAt;

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
