'use client';

/**
 * 生产中心客户端:5 张可点开的卡(四段生命周期 + 风险单)筛选订单表 + 每单生产任务单下载。
 * 数据由 getProductionCenter 派生;此处只做展示/筛选,不含任何价格字段。
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { type ProductionOrderRow, type ProductionStage, type ProductionCenterSummary } from '@/app/actions/production-center';
import { generateManufacturingOrderSheet } from '@/app/actions/manufacturing-order';

const STAGE_LABEL: Record<ProductionStage, string> = {
  awaiting_procurement: '新订单待采购',
  materials_in_transit: '物料在途',
  ready_to_schedule: '开生产待排单',
  in_production: '生产中',
};

type Filter = ProductionStage | 'risk';

const CARDS: { key: Filter; label: string; tone: string; active: string }[] = [
  { key: 'awaiting_procurement', label: '新订单待采购', tone: 'border-gray-200 bg-white', active: 'ring-2 ring-gray-400' },
  { key: 'materials_in_transit', label: '物料在途', tone: 'border-sky-200 bg-sky-50', active: 'ring-2 ring-sky-400' },
  { key: 'ready_to_schedule', label: '开生产待排单', tone: 'border-emerald-200 bg-emerald-50', active: 'ring-2 ring-emerald-400' },
  { key: 'in_production', label: '生产中', tone: 'border-indigo-200 bg-indigo-50', active: 'ring-2 ring-indigo-400' },
  { key: 'risk', label: '⚠ 风险单', tone: 'border-red-200 bg-red-50', active: 'ring-2 ring-red-400' },
];

const STAGE_BADGE: Record<ProductionStage, string> = {
  awaiting_procurement: 'bg-gray-100 text-gray-600 border-gray-200',
  materials_in_transit: 'bg-sky-100 text-sky-700 border-sky-200',
  ready_to_schedule: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  in_production: 'bg-indigo-100 text-indigo-700 border-indigo-200',
};

const NODE_LABEL: Record<string, string> = { pending: '未开始', in_progress: '进行中', done: '已完成', completed: '已完成', blocked: '受阻' };

function nodeText(n: ProductionOrderRow['kickoff']): { text: string; cls: string } {
  if (!n) return { text: '—', cls: 'text-gray-400' };
  const st = String(n.status || 'pending').toLowerCase();
  const done = ['done', 'completed', '已完成'].includes(st);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !done && n.due && n.due < today;
  return {
    text: `${NODE_LABEL[st] || st}${n.due ? ` · ${n.due}` : ''}${overdue ? ' ⚠逾期' : ''}`,
    cls: done ? 'text-emerald-600' : overdue ? 'text-red-600 font-medium' : 'text-gray-600',
  };
}

function MatBar({ m }: { m: ProductionOrderRow['material'] }) {
  if (m.total === 0) return <span className="text-xs text-gray-400">未起料</span>;
  const pct = (n: number) => `${(n / m.total) * 100}%`;
  return (
    <div className="w-32">
      <div className="flex h-2 w-full overflow-hidden rounded bg-gray-100">
        <div className="bg-emerald-400" style={{ width: pct(m.received) }} />
        <div className="bg-sky-300" style={{ width: pct(m.in_transit) }} />
        <div className="bg-gray-300" style={{ width: pct(m.pending) }} />
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500">到 {m.received}/{m.total}{m.pending > 0 ? ` · 未下单 ${m.pending}` : ''}</div>
    </div>
  );
}

function MoDownload({ orderId, orderNo, hasMo }: { orderId: string; orderNo: string; hasMo: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await generateManufacturingOrderSheet(orderId);
      if (res.error || !res.base64) { setErr(res.error || '生成失败'); return; }
      const bytes = atob(res.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName || `生产任务单_${orderNo}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  }
  return (
    <div>
      <button onClick={download} disabled={busy} title={hasMo ? '' : '尚未建生产任务单,点开订单先创建'}
        className={`rounded-lg px-2.5 py-1 text-xs font-medium ${hasMo ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-gray-200 text-gray-500 hover:bg-gray-50'} disabled:opacity-50`}>
        {busy ? '生成中…' : hasMo ? '📋 任务单' : '📋 未建'}
      </button>
      {err && <p className="mt-0.5 max-w-[8rem] text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

export function ProductionCenterClient({ rows, summary }: { rows: ProductionOrderRow[]; summary: ProductionCenterSummary }) {
  const [filter, setFilter] = useState<Filter | null>(null);

  const counts: Record<Filter, number> = {
    awaiting_procurement: summary.awaiting_procurement,
    materials_in_transit: summary.materials_in_transit,
    ready_to_schedule: summary.ready_to_schedule,
    in_production: summary.in_production,
    risk: summary.risk,
  };

  const shown = useMemo(() => {
    if (!filter) return rows;
    if (filter === 'risk') return rows.filter((r) => r.risk);
    return rows.filter((r) => r.stage === filter);
  }, [rows, filter]);

  return (
    <div>
      {/* 卡:点开筛选 */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {CARDS.map((c) => {
          const on = filter === c.key;
          return (
            <button key={c.key} onClick={() => setFilter(on ? null : c.key)}
              className={`rounded-lg border px-4 py-3 text-left transition ${c.tone} ${on ? c.active : 'hover:shadow-sm'}`}>
              <div className="text-2xl font-bold tabular-nums">{counts[c.key]}</div>
              <div className="text-xs text-gray-600">{c.label}</div>
            </button>
          );
        })}
      </div>

      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <span>{filter ? `筛选:${filter === 'risk' ? '风险单' : STAGE_LABEL[filter]} · ${shown.length}` : `全部在产 ${rows.length}`}</span>
        {filter && <button onClick={() => setFilter(null)} className="text-indigo-600 hover:underline">清除筛选</button>}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white py-12 text-center text-gray-400">此桶暂无订单</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[940px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">订单 / 客户</th>
                <th className="px-3 py-2 font-medium">阶段</th>
                <th className="px-3 py-2 font-medium">数量</th>
                <th className="px-3 py-2 font-medium">物料就绪</th>
                <th className="px-3 py-2 font-medium">工厂 / 工厂期</th>
                <th className="px-3 py-2 font-medium">开裁</th>
                <th className="px-3 py-2 font-medium">工厂完成</th>
                <th className="px-3 py-2 font-medium">任务单</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((r) => {
                const k = nodeText(r.kickoff);
                const c = nodeText(r.completion);
                const orderNo = r.internal_order_no || r.order_no || '订单';
                return (
                  <tr key={r.order_id} className={`hover:bg-gray-50 ${r.risk ? 'border-l-2 border-l-red-400' : ''}`}>
                    <td className="px-3 py-2.5">
                      <Link href={`/orders/${r.order_id}`} className="font-medium text-gray-900 hover:underline">{orderNo}</Link>
                      {r.risk && <span className="ml-1 text-[11px] text-red-600">⚠</span>}
                      <div className="text-xs text-gray-500">{r.customer_name || '—'}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STAGE_BADGE[r.stage]}`}>{STAGE_LABEL[r.stage]}</span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-gray-700">{r.quantity?.toLocaleString() ?? '—'}</td>
                    <td className="px-3 py-2.5"><MatBar m={r.material} /></td>
                    <td className="px-3 py-2.5">
                      <div className="text-gray-700">{r.factory_name || <span className="text-gray-400">未指定</span>}</div>
                      <div className="text-xs text-gray-500">{r.factory_date || '—'}</div>
                    </td>
                    <td className={`px-3 py-2.5 text-xs ${k.cls}`}>{k.text}</td>
                    <td className={`px-3 py-2.5 text-xs ${c.cls}`}>{c.text}</td>
                    <td className="px-3 py-2.5"><MoDownload orderId={r.order_id} orderNo={orderNo} hasMo={r.has_mo} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
