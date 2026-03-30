import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { MemoForm } from '@/components/MemoForm';
import { MemoItem } from '@/components/MemoItem';

export default async function MemosPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 查询 memo + 关联的 milestone name/due_at
  const { data: memos } = await (supabase.from('user_memos') as any)
    .select('id, content, remind_at, is_done, created_at, order_id, linked_order_no, milestone_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const allMemos = (memos || []) as any[];

  // 批量查 milestone 信息（避免 N+1）
  const milestoneIds = allMemos.map((m: any) => m.milestone_id).filter(Boolean);
  let milestoneMap: Record<string, { name: string; due_at: string | null }> = {};
  if (milestoneIds.length > 0) {
    const { data: milestones } = await (supabase.from('milestones') as any)
      .select('id, name, due_at')
      .in('id', milestoneIds);
    for (const ms of milestones || []) {
      milestoneMap[ms.id] = { name: ms.name, due_at: ms.due_at };
    }
  }

  // 合并 milestone 信息到 memo
  const enrichedMemos = allMemos.map((m: any) => {
    const ms = m.milestone_id ? milestoneMap[m.milestone_id] : null;
    return {
      ...m,
      milestone_name: ms?.name || null,
      milestone_due_at: ms?.due_at || null,
    };
  });

  const now = new Date();

  // 分组
  const dueReminders = enrichedMemos.filter((m: any) => !m.is_done && m.remind_at && new Date(m.remind_at) <= now);
  const activeMemos = enrichedMemos.filter((m: any) => !m.is_done && !(m.remind_at && new Date(m.remind_at) <= now));
  const doneMemos = enrichedMemos.filter((m: any) => m.is_done);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      {/* 页头 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-lg">
            📝
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">备忘录</h1>
            <p className="text-sm text-gray-500">
              {enrichedMemos.filter((m: any) => !m.is_done).length} 条待办
              {dueReminders.length > 0 && <span className="text-amber-600 ml-2">· {dueReminders.length} 条提醒到期</span>}
            </p>
          </div>
        </div>
      </div>

      {/* 新增表单 */}
      <div className="mb-6">
        <MemoForm />
      </div>

      {/* 到期提醒 */}
      {dueReminders.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-600 text-lg">🔔</span>
            <h2 className="text-sm font-semibold text-amber-800">到期提醒</h2>
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{dueReminders.length}</span>
          </div>
          <div className="space-y-2">
            {dueReminders.map((memo: any) => (
              <MemoItem key={memo.id} memo={memo} />
            ))}
          </div>
        </div>
      )}

      {/* 待办 */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-indigo-600 text-lg">📋</span>
          <h2 className="text-sm font-semibold text-gray-700">待办</h2>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{activeMemos.length}</span>
        </div>
        {activeMemos.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">暂无待办事项，点击"新增备忘"添加</p>
        ) : (
          <div className="space-y-2">
            {activeMemos.map((memo: any) => (
              <MemoItem key={memo.id} memo={memo} />
            ))}
          </div>
        )}
      </div>

      {/* 已完成 */}
      {doneMemos.length > 0 && (
        <details className="mb-6">
          <summary className="flex items-center gap-2 mb-3 cursor-pointer text-sm text-gray-400 hover:text-gray-600">
            <span>✓ 已完成 ({doneMemos.length})</span>
          </summary>
          <div className="space-y-2">
            {doneMemos.map((memo: any) => (
              <MemoItem key={memo.id} memo={memo} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
