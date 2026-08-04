'use client';

/**
 * 行政督办 · 僵尸订单核实区(2026-08-04,CEO 要求)。
 *
 * CEO 原话:
 *   「这些出厂日期已过的,要显示在督办总览里,让行政督办能看到、去督办。」
 *   「行政督办的工作台也要做好,就是来催进度、解决大家的逾期、处理这些类似于僵尸订单等。」
 *
 * 为什么单独一区而不是混在下面的表里:实测 372 个逾期节点里 44% 落在这类单上,
 * 混着看等于没有预警。这里把它们**提到最前面**,并且分成两种、给两种动作:
 *   · 疑似已出货没维护 → 督办**核实实际情况**,确认后一键收尾(出运前节点一次补齐)
 *   · 真晚了还在推     → 催责任人(走 /api/nudge,每节点每小时限一次)
 *
 * 「核实」是这个角色的核心动作 —— 督办不改业务数据,只负责摸清情况 + 推动,
 * 所以这里只给「确认已出货(收尾)」和「催办」两个出口,不给编辑。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { confirmOrderShipped } from '@/app/actions/confirm-shipped';
import { useDialogs } from '@/components/ui/useDialogs';

export interface ZombieRow {
  order_id: string;
  no: string;
  customer: string | null;
  factory_date: string | null;
  pastFactoryDays: number | null;
  idleDays: number | null;
  neverTouched: boolean;
  overdueCount: number;
  why: string;
  owner: string | null;
}

export function ZombieOrderPanel({ suspected, stalled }: { suspected: ZombieRow[]; stalled: ZombieRow[] }) {
  const { confirm, dialog } = useDialogs();
  const router = useRouter();
  const [busy, setBusy] = useState<string>('');
  const [done, setDone] = useState<Record<string, string>>({});

  if (suspected.length === 0 && stalled.length === 0) return null;

  async function finish(r: ZombieRow) {
    const ok = await confirm({
      title: `确认「${r.no}」整单已出货?`,
      message:
        `${r.why}\n\n` +
        '确认后:出运前所有未完成节点一次性补录完成(收款除外),逾期消失、订单收尾。\n' +
        '⚠️ 请先跟业务/跟单核实过实际已出货,再点确认 —— 这一步会改动订单状态。',
      confirmText: '已核实,确认收尾',
    });
    if (!ok) return;
    setBusy(r.order_id);
    const res = await confirmOrderShipped(r.order_id);
    setBusy('');
    if (!res.ok) {
      await confirm({ title: '收尾失败', message: res.error || '未知错误', confirmText: '知道了' });
      return;
    }
    setDone((p) => ({ ...p, [r.order_id]: res.completed ? '✅ 已收尾' : '✅ 已出货(留收款)' }));
    setTimeout(() => router.refresh(), 800);
  }

  const Row = ({ r, kind }: { r: ZombieRow; kind: 'suspected' | 'stalled' }) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white border border-gray-200 px-3 py-2 text-sm">
      <Link href={`/orders/${r.order_id}`} className="font-medium text-indigo-700 hover:underline shrink-0">{r.no}</Link>
      <span className="text-gray-600 truncate max-w-[9rem]">{r.customer || '—'}</span>
      <span className="text-xs text-gray-400 shrink-0">出厂 {r.factory_date || '—'}</span>
      <span className="text-xs text-red-600 shrink-0">已过 {r.pastFactoryDays} 天</span>
      <span className="text-xs text-gray-500 shrink-0">
        {r.neverTouched ? '从未推进' : `静默 ${r.idleDays} 天`} · 逾期 {r.overdueCount} 个
      </span>
      {r.owner && <span className="text-xs text-gray-500 shrink-0">👤 {r.owner}</span>}
      <span className="grow" />
      {done[r.order_id] ? (
        <span className="text-xs font-medium text-emerald-700">{done[r.order_id]}</span>
      ) : kind === 'suspected' ? (
        <button
          onClick={() => finish(r)}
          disabled={busy === r.order_id}
          className="text-xs font-medium px-3 py-1 rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 shrink-0"
        >
          {busy === r.order_id ? '处理中…' : '核实后收尾'}
        </button>
      ) : (
        <Link
          href={`/orders/${r.order_id}`}
          className="text-xs font-medium px-3 py-1 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 shrink-0"
        >
          去催进度
        </Link>
      )}
    </div>
  );

  return (
    <div className="mb-5 space-y-4">
      {dialog}

      {suspected.length > 0 && (
        <section className="rounded-xl border-2 border-orange-300 bg-orange-50/60 p-3">
          <h2 className="text-sm font-semibold text-orange-900">
            🧟 疑似已出货、没人维护 — {suspected.length} 张(共 {suspected.reduce((a, r) => a + r.overdueCount, 0)} 个逾期节点)
          </h2>
          <p className="text-[11px] text-orange-700/80 mt-0.5 mb-2">
            出厂日已过、且长期没人点过任何节点。这类单占了全部逾期的近一半 ——
            <b>它们不清掉,真正要盯的单就看不见</b>。请逐单跟业务/跟单核实实际情况,确认已出货的直接收尾。
          </p>
          <div className="space-y-1.5">
            {suspected.map((r) => <Row key={r.order_id} r={r} kind="suspected" />)}
          </div>
        </section>
      )}

      {stalled.length > 0 && (
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-3">
          <h2 className="text-sm font-semibold text-red-800">
            ⏰ 真延误、还在推 — {stalled.length} 张
          </h2>
          <p className="text-[11px] text-red-700/80 mt-0.5 mb-2">
            出厂日已过,但近期确实有人在推进。<b>这些是真的晚了,要催责任人</b>,不要当僵尸单收尾。
          </p>
          <div className="space-y-1.5">
            {stalled.map((r) => <Row key={r.order_id} r={r} kind="stalled" />)}
          </div>
        </section>
      )}
    </div>
  );
}
