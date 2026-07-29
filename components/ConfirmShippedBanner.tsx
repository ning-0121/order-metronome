'use client';

/** 出厂日已过确认区(2026-07-28 CEO):逐单问"是否已出货",点「已出货」→ 除收款外节点补录完成,逾期消失。 */

import { useState } from 'react';
import Link from 'next/link';
import { confirmOrderShipped } from '@/app/actions/confirm-shipped';

export interface PastDueItem { id: string; no: string; customer: string; factoryDate: string; daysOver: number; }

export function ConfirmShippedBanner({ items }: { items: PastDueItem[] }) {
  const [open, setOpen] = useState(items.length <= 5);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (items.length === 0) return null;

  async function confirm(it: PastDueItem) {
    if (!window.confirm(`确认「${it.no}」整单已出货?\n出运前所有未完成节点将补录完成(收款除外),逾期消失。`)) return;
    setBusy(it.id);
    const r = await confirmOrderShipped(it.id);
    setBusy('');
    if (!r.ok) { setMsg((p) => ({ ...p, [it.id]: '❌ ' + (r.error || '失败') })); return; }
    setMsg((p) => ({ ...p, [it.id]: r.completed ? '✅ 已完成' : '✅ 已出货(保留收款)' }));
    setTimeout(() => location.reload(), 800);
  }

  return (
    <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50/60 p-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <span className="text-sm font-semibold text-orange-800">🚢 出厂日已过 {items.length} 张 — 请逐单确认是否已出货</span>
        <span className="text-xs text-orange-500">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {items.map((it) => (
            <div key={it.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white border border-orange-100 px-3 py-2 text-sm">
              <Link href={`/orders/${it.id}`} className="font-medium text-indigo-700 hover:underline">{it.no}</Link>
              <span className="text-gray-500 truncate">{it.customer}</span>
              <span className="text-xs text-gray-400">出厂 {it.factoryDate}</span>
              <span className="text-xs text-red-600">已过 {it.daysOver} 天</span>
              <span className="ml-auto flex items-center gap-2">
                {msg[it.id] && <span className="text-xs">{msg[it.id]}</span>}
                <button onClick={() => confirm(it)} disabled={busy === it.id}
                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {busy === it.id ? '…' : '✅ 已出货'}
                </button>
                <Link href={`/orders/${it.id}?tab=progress`} className="text-xs text-gray-400 hover:text-indigo-600">还在跳→申请延期</Link>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
