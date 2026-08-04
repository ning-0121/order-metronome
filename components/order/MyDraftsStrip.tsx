'use client';

/**
 * 订单中心「我的未完成草稿」(2026-08-04 CEO)。
 *
 * CEO 原话:「订单中心里应该有每个人做一半的草稿,这样因为什么事情被打断,
 * 可以点进去接着做。」
 *
 * 为什么非补这个不可:草稿功能 2026-07-30 就上线了,`saveOrderDraft` /
 * `listMyOrderDrafts` / `getOrderDraft` 全都写好了 —— 但**回到草稿的唯一入口
 * 在建单表单内部**。人一旦离开建单页,就再也找不到自己存的东西。
 * 结果 order_drafts 上线至今 **0 行**:能存,但没有回去的路,所以没人存。
 *
 * 这里就是那条路:列出**我自己**的草稿(RLS 只给本人),点「接着填」带 ?draft=xxx
 * 进建单页自动回填。
 *
 * 附件不进草稿(浏览器不允许回填文件框),所以卡片上直接写明要重新选,
 * 免得人以为传过的 PO 还在。
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { listMyOrderDrafts, deleteOrderDraft, type OrderDraftRow } from '@/app/actions/order-drafts';

function ago(ts: string): string {
  const t = new Date(ts).getTime();
  if (isNaN(t)) return ts;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days} 天前` : new Date(t).toISOString().slice(0, 10);
}

export function MyDraftsStrip() {
  const [drafts, setDrafts] = useState<OrderDraftRow[]>([]);
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const res = await listMyOrderDrafts();
    setDrafts(res.data || []);
    setLoaded(true);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // 没有草稿就整块不出现 —— 不给列表页添噪音
  if (!loaded || drafts.length === 0) return null;

  async function remove(id: string) {
    if (!window.confirm('删除这份草稿?删了不可恢复。')) return;
    setBusy(id);
    await deleteOrderDraft(id);
    setBusy('');
    void refresh();
  }

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold text-indigo-900">✏️ 我的未完成草稿 · {drafts.length}</h2>
        <span className="text-[11px] text-indigo-700/80">填了一半被打断的,点「接着填」继续 —— 换台电脑登录也在</span>
      </div>
      <div className="space-y-1.5">
        {drafts.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white border border-indigo-100 px-3 py-2 text-sm">
            <span className="font-medium text-gray-900 truncate max-w-[16rem]">{d.label || '未命名草稿'}</span>
            <span className="text-xs text-gray-400">{d.fieldCount} 项 · 存于 {ago(d.updatedAt)}</span>
            <span className="text-[11px] text-amber-700">附件需重新选</span>
            <span className="grow" />
            <Link
              href={`/orders/new?draft=${d.id}`}
              className="text-xs font-medium px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shrink-0"
            >
              接着填 →
            </Link>
            <button
              onClick={() => remove(d.id)}
              disabled={busy === d.id}
              className="text-xs text-gray-400 hover:text-rose-600 disabled:opacity-50 shrink-0"
            >
              {busy === d.id ? '删除中…' : '删除'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
