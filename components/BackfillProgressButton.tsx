'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { backfillMilestonesToCurrent } from '@/app/actions/milestones';
import { useDialogs } from '@/components/ui/useDialogs';

/**
 * 一键补录到当前进度:把「当前在办节点之前」还没点完成的历史节点一次性标完成(带留痕)。
 * 用于跟单没及时点完成、早期节点(PO确认/原辅料验收…)一直报超期拖红的情况——补录后红牌自动消。
 */
export function BackfillProgressButton({ orderId }: { orderId: string }) {
  const { confirm, dialog } = useDialogs();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const ok = await confirm({
      title: '一键补录到当前进度?',
      message: '把「当前在办节点之前」还没点完成的历史节点,一次性标为已完成(逐条留痕)。\n用于早期节点做了没点、一直报超期拖红的情况。阻塞节点和当前在办节点不动。',
      confirmText: '补录',
    });
    if (!ok) return;
    setBusy(true);
    const r = await backfillMilestonesToCurrent(orderId);
    setBusy(false);
    if (r.error) { await confirm({ title: '补录失败', message: r.error, confirmText: '知道了' }); return; }
    await confirm({
      title: r.filled ? `已补录 ${r.filled} 个节点` : '无需补录',
      message: r.filled ? '当前进度之前的历史欠点已标完成,红牌会随之消除。' : '当前进度之前没有欠点的节点。',
      confirmText: '好',
    });
    router.refresh();
  }

  return (
    <>
      {dialog}
      <button onClick={onClick} disabled={busy}
        className="text-xs px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 whitespace-nowrap"
        title="把当前进度之前还没点完成的历史节点一次性标完成(带留痕),清掉早期节点的超期红牌">
        {busy ? '补录中…' : '⏱ 一键补录到当前进度'}
      </button>
    </>
  );
}
