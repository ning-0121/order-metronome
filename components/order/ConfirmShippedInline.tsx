'use client';

/**
 * 订单详情页的「确认已出货」入口(2026-08-03 CEO 反馈后加)。
 *
 * 背景:这个动作本来只挂在**订单列表页**的「出厂日已过确认区」横幅上。
 * CEO 在详情页补录完进度、想标记这单已出货,找不到入口 —— 只能回列表页翻横幅。
 *
 * 而且「一键补录到当前进度」帮不上忙:它只补「当前在办节点**之前**」的欠点,
 * 一张刚建的历史单里所有节点都还 pending,"之前"根本没有欠点 → 点了等于没点。
 * 真正要的是这个动作:除收款外的未完成节点全部补录完成,逾期消失,订单收尾。
 *
 * 显示条件与列表页横幅保持同一口径(出厂日已过 + 未终结 + 没有已完成的出运节点),
 * 免得两处判断分叉。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { confirmOrderShipped } from '@/app/actions/confirm-shipped';
import { useDialogs } from '@/components/ui/useDialogs';

export function ConfirmShippedInline({
  orderId, orderNo, factoryDate, daysOver,
}: {
  orderId: string;
  orderNo: string;
  factoryDate: string;
  daysOver: number;
}) {
  const { confirm, dialog } = useDialogs();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: `确认「${orderNo}」整单已出货?`,
      message:
        `出厂日 ${factoryDate},已过 ${daysOver} 天。\n\n` +
        '确认后:出运前所有未完成节点一次性补录完成(收款除外),逾期消失。\n' +
        '若本单没有待收款节点,订单直接收尾。\n\n' +
        '有在途分批的单不能走这个捷径,请到「出货单据」按批确认。',
      confirmText: '确认已出货',
    });
    if (!ok) return;
    setBusy(true);
    const r = await confirmOrderShipped(orderId);
    setBusy(false);
    if (!r.ok) {
      await confirm({ title: '确认失败', message: r.error || '未知错误', confirmText: '知道了' });
      return;
    }
    setDone(r.completed ? '✅ 已出货,订单已收尾' : '✅ 已出货(保留收款节点)');
    setTimeout(() => router.refresh(), 700);
  }

  if (done) return <span className="text-sm font-medium text-emerald-700">{done}</span>;

  return (
    <>
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onClick}
          disabled={busy}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 whitespace-nowrap"
        >
          {busy ? '处理中…' : '🚢 确认整单已出货'}
        </button>
        <span className="text-[11px] text-gray-500">
          出厂日已过 {daysOver} 天。已出货的话点这里,出运前节点一次补齐、逾期消失。
        </span>
      </div>
    </>
  );
}
