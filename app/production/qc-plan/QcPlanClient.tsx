'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { FactoryGroup, InspectionItem } from '@/app/actions/qc-inspection-plan';

const LAYER_STYLE: Record<InspectionItem['layer'], string> = {
  'QC独检': 'bg-indigo-100 text-indigo-700',
  '业务确认': 'bg-gray-100 text-gray-600',
  '跟单放行': 'bg-amber-100 text-amber-700',
};
const URGENCY: Record<InspectionItem['urgency'], { label: string; cls: string }> = {
  overdue: { label: '已过期', cls: 'text-red-600 font-semibold' },
  soon: { label: '7天内', cls: 'text-amber-600 font-medium' },
  later: { label: '', cls: 'text-gray-400' },
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function QcPlanClient({ groups, summary }: { groups: FactoryGroup[]; summary: { total: number; overdue: number; soon: number; qcOwn: number } }) {
  const [onlyQc, setOnlyQc] = useState(false);
  const [onlyUrgent, setOnlyUrgent] = useState(false);

  const shown = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) =>
        (!onlyQc || it.layer === 'QC独检') &&
        (!onlyUrgent || it.urgency === 'overdue' || it.urgency === 'soon')),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      {/* 汇总 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="待验货节点" value={summary.total}
          active={!onlyQc && !onlyUrgent} hint="清空筛选,看全部待验货节点"
          onClick={() => { setOnlyQc(false); setOnlyUrgent(false); }} />
        <Stat label="已过期" value={summary.overdue} tone="red"
          active={onlyUrgent} hint="只看已过期 / 7 天内"
          onClick={() => setOnlyUrgent(!onlyUrgent)} />
        <Stat label="7 天内" value={summary.soon} tone="amber"
          active={onlyUrgent} hint="只看已过期 / 7 天内(与「已过期」同一筛选)"
          onClick={() => setOnlyUrgent(!onlyUrgent)} />
        <Stat label="QC 独检(中/尾检)" value={summary.qcOwn} tone="indigo"
          active={onlyQc} hint="只看 QC 独检(中检/尾检)"
          onClick={() => setOnlyQc(!onlyQc)} />
      </div>

      {/* 筛选 */}
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyQc} onChange={(e) => setOnlyQc(e.target.checked)} />只看 QC 独检(中检/尾检)</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyUrgent} onChange={(e) => setOnlyUrgent(e.target.checked)} />只看过期/7天内</label>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">没有符合条件的待验货节点 ✅</p>
      ) : (
        shown.map((g) => (
          <div key={g.factory} className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
              <span className="font-semibold text-gray-800">🏭 {g.factory}</span>
              <span className="text-xs text-gray-500">{g.items.length} 项</span>
              {g.overdueCount > 0 && <span className="text-xs text-red-600 font-medium">· {g.overdueCount} 已过期</span>}
              <span className="text-xs text-gray-400 ml-auto">最早 {fmtDate(g.earliestDue)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-400">
                  <tr className="text-left">
                    <th className="px-4 py-2">验货日</th><th className="px-3 py-2">订单</th><th className="px-3 py-2">客户</th>
                    <th className="px-3 py-2">验货节点</th><th className="px-3 py-2">出厂日</th><th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {g.items.map((it) => (
                    <tr key={it.milestoneId} className={it.urgency === 'overdue' ? 'bg-red-50/40' : ''}>
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">{fmtDate(it.dueAt)}
                        {it.daysToDue != null && <span className={`ml-1.5 ${URGENCY[it.urgency].cls}`}>{it.urgency === 'overdue' ? `逾${-it.daysToDue}天` : it.urgency === 'soon' ? `${it.daysToDue}天` : ''}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/orders/${it.orderId}?from=/production/qc-plan`} className="text-indigo-600 hover:underline font-medium">{it.orderRef}</Link>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{it.customer || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded ${LAYER_STYLE[it.layer]}`}>{it.layer}</span>
                        <span className="ml-1.5 text-gray-700">{it.nodeName}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap tabular-nums">{fmtDate(it.factoryDate)}</td>
                      <td className="px-3 py-2 text-right">
                        <Link href={`/production/order/${it.orderId}`} className="text-indigo-600 hover:underline">录验货 →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * 统计卡。2026-08-21 起可点 —— 此前是纯 <div>,数字摆在那儿却点不动
 * (CEO:「巡查计划这里的四个模板点不动」)。点击 = 切换对应筛选,
 * 复用下方 checkbox 的同一份 state,不新增第二套过滤口径。
 */
function Stat({ label, value, tone, active, onClick, hint }: {
  label: string; value: number; tone?: 'red' | 'amber' | 'indigo';
  active?: boolean; onClick?: () => void; hint?: string;
}) {
  const c = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : tone === 'indigo' ? 'text-indigo-600' : 'text-gray-900';
  const base = `rounded-xl border p-3 text-center transition ${active ? 'border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200' : 'border-gray-200 bg-white'}`;
  if (!onClick) {
    return (
      <div className={base}>
        <div className={`text-2xl font-bold ${c}`}>{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} title={hint}
      className={`${base} w-full cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400`}>
      <div className={`text-2xl font-bold ${c}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}{active ? ' ·筛选中' : ''}</div>
    </button>
  );
}
