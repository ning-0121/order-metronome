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

/** 协作订单风险:同一客户的订单折叠成一组,可展开/收起(客户多单时最有用,如 EHL 一堆)。 */
export function CollabRiskGroups({ items }: { items: CollabRiskItem[] }) {
  // 按客户分组,单数多的客户排前
  const groupMap = new Map<string, CollabRiskItem[]>();
  for (const it of items) {
    const k = it.customerName?.trim() || '(未命名客户)';
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k)!.push(it);
  }
  const groups = [...groupMap.entries()].sort((a, b) => b[1].length - a[1].length);

  // 默认:多单客户收起(可折),单单客户展开(无所谓折)
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(groups.filter(([, v]) => v.length === 1).map(([k]) => k))
  );
  const toggle = (k: string) =>
    setOpen((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const Row = ({ it, idx }: { it: CollabRiskItem; idx: number }) => (
    <div className="px-5 py-3 hover:bg-orange-50/30 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <span className="text-sm font-bold text-orange-600 w-5 text-center flex-shrink-0">{idx}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/orders/${it.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">{it.orderNo}</Link>
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">{it.issueCount} 项</span>
            </div>
            <div className="text-xs text-gray-600 mt-1 space-y-0.5">
              {it.issues.slice(0, 2).map((issue, j) => <div key={j}>• {issue}</div>)}
              {it.issueCount > 2 && <div className="text-gray-400">还有 {it.issueCount - 2} 个...</div>}
            </div>
          </div>
        </div>
        <Link href={it.viewHref} className="flex-shrink-0 bg-orange-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-orange-600">查看</Link>
      </div>
    </div>
  );

  return (
    <div className="divide-y divide-gray-100">
      {groups.map(([customer, list]) => {
        const isOpen = open.has(customer);
        const totalIssues = list.reduce((s, x) => s + (x.issueCount || 0), 0);
        // 单单客户:直接显示那一行,不做折叠头(免无谓一层)
        if (list.length === 1) return <Row key={customer} it={list[0]} idx={1} />;
        return (
          <div key={customer}>
            <button
              onClick={() => toggle(customer)}
              className="w-full flex items-center gap-2 px-5 py-2.5 text-left hover:bg-orange-50/50 transition-colors"
            >
              <span className="text-gray-400 text-xs w-3">{isOpen ? '▾' : '▸'}</span>
              <span className="font-semibold text-gray-800 text-sm">{customer}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">{list.length} 单</span>
              <span className="text-xs text-gray-500">共 {totalIssues} 项</span>
              {!isOpen && (
                <span className="text-xs text-gray-400 truncate ml-1">
                  {list[0]?.issues?.[0] ? '· ' + list[0].issues[0] : ''}
                </span>
              )}
            </button>
            {isOpen && (
              <div className="divide-y divide-gray-100 bg-orange-50/20">
                {list.map((it, i) => <Row key={it.orderId} it={it} idx={i + 1} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
