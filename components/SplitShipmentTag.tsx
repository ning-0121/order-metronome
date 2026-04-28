'use client';

/**
 * 分批出货标签 — 订单详情页头部快捷按钮
 *
 * 业务背景：
 * 客户分批下 PO 或分批收货时（如 485 / 485B / 485B-1 系列），
 * 部分款已出货、部分未推进，订单整体被算超期会污染看板。
 *
 * 这个标签是**轻量提示**，不改变超期判定逻辑（超期判定仍按 factory_date）。
 * 让业务能视觉上一眼识别"这单是分批出货中"，配合方案 A（拆订单）
 * 或后续方案 B（分批出货数据结构）使用。
 *
 * 实现：复用 orders.special_tags text[] 字段，追加/移除"分批出货中"
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const TAG_LABEL = '分批出货中';

interface Props {
  orderId: string;
  orderNo: string;
  initialTags: string[];
  /** 仅订单负责人 / admin / 业务 可操作 */
  canEdit: boolean;
}

export function SplitShipmentTag({ orderId, orderNo, initialTags, canEdit }: Props) {
  const router = useRouter();
  const [tags, setTags] = useState<string[]>(initialTags || []);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isMarked = tags.includes(TAG_LABEL);

  async function toggle() {
    if (!canEdit || pending) return;
    setError(null);

    const next = isMarked
      ? tags.filter(t => t !== TAG_LABEL)
      : [...tags, TAG_LABEL];

    startTransition(async () => {
      try {
        const { createClient } = await import('@/lib/supabase/client');
        const supabase = createClient();
        const { error: upErr } = await (supabase.from('orders') as any)
          .update({ special_tags: next, updated_at: new Date().toISOString() })
          .eq('id', orderId);
        if (upErr) {
          setError(upErr.message);
          return;
        }
        // 写 order_logs 留痕
        try {
          const { data: { user } } = await supabase.auth.getUser();
          await (supabase.from('order_logs') as any).insert({
            order_id: orderId,
            actor_user_id: user?.id || null,
            action: 'special_tag_toggle',
            note: isMarked ? `移除标签：${TAG_LABEL}` : `添加标签：${TAG_LABEL}（${orderNo}）`,
            created_at: new Date().toISOString(),
          });
        } catch { /* 日志失败不阻断 */ }

        setTags(next);
        router.refresh();
      } catch (e: any) {
        setError(e?.message || '未知错误');
      }
    });
  }

  // 不可编辑且未标记 → 不显示按钮
  if (!canEdit && !isMarked) return null;

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={!canEdit || pending}
        title={
          !canEdit
            ? '仅订单业务/管理员可修改'
            : isMarked
              ? '点击移除标签'
              : '标记为分批出货中（不影响超期判定，仅作提示）'
        }
        className={`text-xs font-medium px-2.5 py-1 rounded-full transition-all ${
          isMarked
            ? 'bg-purple-100 text-purple-700 hover:bg-purple-200 ring-1 ring-purple-300'
            : 'bg-gray-50 text-gray-500 hover:bg-purple-50 hover:text-purple-600 border border-dashed border-gray-300'
        } ${!canEdit ? 'cursor-default' : 'cursor-pointer'} ${pending ? 'opacity-60' : ''}`}
      >
        {pending ? '处理中…' : isMarked ? `📦 ${TAG_LABEL}` : `+ ${TAG_LABEL}`}
      </button>
      {error && (
        <span className="text-xs text-red-600 ml-1" title={error}>⚠ 失败</span>
      )}
    </div>
  );
}
