'use client';

/**
 * 「颜色待定」标签 — 订单详情页头部快捷按钮(2026-07-11 用户拍板)。
 * 颜色还没定就能先推进:PO确认免「颜色核对一致」;颜色定了到订单明细补齐,再点一下取消标签。
 * 复用 orders.special_tags text[](无迁移),与 SplitShipmentTag 同款实现。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { COLOR_PENDING_TAG } from '@/lib/domain/colorPending';

interface Props {
  orderId: string;
  orderNo: string;
  initialTags: string[];
  /** 仅订单负责人 / admin / 业务 可操作 */
  canEdit: boolean;
}

export function ColorPendingTag({ orderId, orderNo, initialTags, canEdit }: Props) {
  const router = useRouter();
  const [tags, setTags] = useState<string[]>(initialTags || []);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isMarked = tags.includes(COLOR_PENDING_TAG);

  async function toggle() {
    if (!canEdit || pending) return;
    setError(null);
    const next = isMarked
      ? tags.filter(t => t !== COLOR_PENDING_TAG)
      : [...tags, COLOR_PENDING_TAG];

    startTransition(async () => {
      try {
        const { createClient } = await import('@/lib/supabase/client');
        const supabase = createClient();
        const { error: upErr } = await (supabase.from('orders') as any)
          .update({ special_tags: next, updated_at: new Date().toISOString() })
          .eq('id', orderId);
        if (upErr) { setError(upErr.message); return; }
        try {
          const { data: { user } } = await supabase.auth.getUser();
          await (supabase.from('order_logs') as any).insert({
            order_id: orderId,
            actor_user_id: user?.id || null,
            action: 'special_tag_toggle',
            note: isMarked ? `取消标签：${COLOR_PENDING_TAG}(颜色已确定)` : `添加标签：${COLOR_PENDING_TAG}(${orderNo})`,
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
              ? '颜色已确定?到订单明细补齐颜色后,点此取消「颜色待定」'
              : '颜色还没定 → 标记待定,可先推进(PO确认免颜色核对),颜色定了再补'
        }
        className={`text-xs font-medium px-2.5 py-1 rounded-full transition-all ${
          isMarked
            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 ring-1 ring-amber-300'
            : 'bg-gray-50 text-gray-500 hover:bg-amber-50 hover:text-amber-600 border border-dashed border-gray-300'
        } ${!canEdit ? 'cursor-default' : 'cursor-pointer'} ${pending ? 'opacity-60' : ''}`}
      >
        {pending ? '处理中…' : isMarked ? `⏳ ${COLOR_PENDING_TAG}` : `+ ${COLOR_PENDING_TAG}`}
      </button>
      {error && (
        <span className="text-xs text-red-600 ml-1" title={error}>⚠ 失败</span>
      )}
    </div>
  );
}
