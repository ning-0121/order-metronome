'use client';

import { useState } from 'react';
import Link from 'next/link';

export interface CollabRiskItem {
  orderId: string;
  orderNo: string;
  customerName: string;
  issueCount: number;
  issues: string[];
  viewHref: string;
}

type Tone = 'red' | 'amber' | 'orange';

// Tailwind 类名必须写全(JIT 不识别拼接),按 tone 显式列出。
const TONE: Record<Tone, { idx: string; badge: string; btn: string; rowHover: string; headHover: string; openBg: string }> = {
  red:    { idx: 'text-red-600',    badge: 'bg-red-100 text-red-700',       btn: 'bg-red-600 hover:bg-red-700',       rowHover: 'hover:bg-red-50/30',    headHover: 'hover:bg-red-50/50',    openBg: 'bg-red-50/20' },
  amber:  { idx: 'text-amber-600',  badge: 'bg-amber-100 text-amber-700',   btn: 'bg-amber-500 hover:bg-amber-600',   rowHover: 'hover:bg-amber-50/30',  headHover: 'hover:bg-amber-50/50',  openBg: 'bg-amber-50/20' },
  orange: { idx: 'text-orange-600', badge: 'bg-orange-100 text-orange-700', btn: 'bg-orange-500 hover:bg-orange-600', rowHover: 'hover:bg-orange-50/30', headHover: 'hover:bg-orange-50/50', openBg: 'bg-orange-50/20' },
};

/** 风险订单按客户折叠成一组、可展开(同客户多单时最有用,如 EHL 一堆);三栏共用,tone 配色。 */
export function CollabRiskGroups({ items, tone = 'orange', ctaLabel = '查看' }: { items: CollabRiskItem[]; tone?: Tone; ctaLabel?: string }) {
  const t = TONE[tone];
  const groupMap = new Map<string, CollabRiskItem[]>();
  for (const it of items) {
    const k = it.customerName?.trim() || '(未命名客户)';
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k)!.push(it);
  }
  const groups = [...groupMap.entries()].sort((a, b) => b[1].length - a[1].length);

  // 默认:多单客户收起(可折),单单客户展开
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(groups.filter(([, v]) => v.length === 1).map(([k]) => k))
  );
  const toggle = (k: string) =>
    setOpen((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // showCustomer:单单客户组无折叠头 → 行内显示客户名(否则丢名);多单组的行由头显示客户,行内不重复。
  const Row = ({ it, idx, showCustomer }: { it: CollabRiskItem; idx: number; showCustomer?: boolean }) => (
    <div className={`px-5 py-3 ${t.rowHover} transition-colors`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <span className={`text-sm font-bold ${t.idx} w-5 text-center flex-shrink-0`}>{idx}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/orders/${it.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">{it.orderNo}</Link>
              {showCustomer && <span className="text-gray-500 text-sm truncate">{it.customerName?.trim() || '(未命名客户)'}</span>}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.badge}`}>{it.issueCount} 项</span>
            </div>
            <div className="text-xs text-gray-600 mt-1 space-y-0.5">
              {it.issues.slice(0, 2).map((issue, j) => <div key={j}>• {issue}</div>)}
              {it.issueCount > 2 && <div className="text-gray-400">还有 {it.issueCount - 2} 个...</div>}
            </div>
          </div>
        </div>
        <Link href={it.viewHref} className={`flex-shrink-0 text-white px-3 py-1.5 rounded-lg text-xs font-medium ${t.btn}`}>{ctaLabel}</Link>
      </div>
    </div>
  );

  return (
    <div className="divide-y divide-gray-100">
      {groups.map(([customer, list]) => {
        const isOpen = open.has(customer);
        const totalIssues = list.reduce((s, x) => s + (x.issueCount || 0), 0);
        if (list.length === 1) return <Row key={customer} it={list[0]} idx={1} showCustomer />;
        return (
          <div key={customer}>
            <button onClick={() => toggle(customer)} className={`w-full flex items-center gap-2 px-5 py-2.5 text-left ${t.headHover} transition-colors`}>
              <span className="text-gray-400 text-xs w-3">{isOpen ? '▾' : '▸'}</span>
              <span className="font-semibold text-gray-800 text-sm">{customer}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.badge}`}>{list.length} 单</span>
              <span className="text-xs text-gray-500">共 {totalIssues} 项</span>
              {!isOpen && list[0]?.issues?.[0] && (
                <span className="text-xs text-gray-400 truncate ml-1">· {list[0].issues[0]}</span>
              )}
            </button>
            {isOpen && (
              <div className={`divide-y divide-gray-100 ${t.openBg}`}>
                {list.map((it, i) => <Row key={it.orderId} it={it} idx={i + 1} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
