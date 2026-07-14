'use client';

/**
 * 红单体检面板(方案 C·B)——把所有红单一次性列出,按「元凶节点 + 逾期天数」归类:
 *  - 真超期:交期日已过,真风险,要行动;
 *  - 临期紧张:交期日很近(≤7天)但进度低,要盯;
 *  - 疑似没回填/推进滞后:交期日还远却被早期「进行中」节点逾期拖红 → 多半是节点做了没点完成,给跟单核实补录。
 * 纯展示,不动数据。数据在服务端(orders/page)按 computeOrderStatus + getRedCulprits 算好传入。
 */

import { useState } from 'react';
import Link from 'next/link';

export type RedCategory = 'overdue' | 'near' | 'unfilled';
export interface RedItem {
  id: string;
  orderNo: string;
  internalNo?: string | null;
  customer?: string | null;
  deliveryDate?: string | null;
  daysToDelivery?: number | null;
  category: RedCategory;
  culprits: { name: string; daysOverdue: number; kind: 'blocked' | 'overdue' }[];
}

const META: Record<RedCategory, { label: string; hint: string; cls: string; dot: string }> = {
  overdue: { label: '真超期(要行动)', hint: '交期日已过还没出货——催工厂 / 改期 / 跟客户。', cls: 'border-rose-200 bg-rose-50', dot: 'bg-rose-500' },
  near: { label: '临期紧张(要盯)', hint: '交期日 7 天内、进度偏低——重点跟进。', cls: 'border-amber-200 bg-amber-50', dot: 'bg-amber-500' },
  unfilled: { label: '疑似没回填 / 推进滞后(给跟单核实补录)', hint: '交期日还远,却被早期「进行中」节点逾期拖红——多半是节点实际做了没点「完成」。让跟单核实并补录,红牌会自动消;真卡住的则推进第一个在办节点。', cls: 'border-indigo-200 bg-indigo-50', dot: 'bg-indigo-500' },
};

function culpritText(c: RedItem['culprits']): string {
  if (c.length === 0) return '—';
  return c.map((x) => x.kind === 'blocked' ? `${x.name}(阻塞)` : `${x.name}(超期${x.daysOverdue}天)`).join('、');
}

export function RedOrderHealthPanel({ items }: { items: RedItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;

  const groups: RedCategory[] = ['overdue', 'near', 'unfilled'];
  const byCat = (c: RedCategory) => items.filter((i) => i.category === c);
  const unfilledCount = byCat('unfilled').length;

  return (
    <div className="mb-5 rounded-2xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-bold text-gray-800">🩺 红单体检</span>
          <span className="text-gray-500">共 <b className="text-rose-600">{items.length}</b> 单红</span>
          {byCat('overdue').length > 0 && <span className="text-xs px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">真超期 {byCat('overdue').length}</span>}
          {unfilledCount > 0 && <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">疑似没回填 {unfilledCount}</span>}
        </div>
        <span className="text-xs text-indigo-600">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          {groups.map((cat) => {
            const list = byCat(cat);
            if (list.length === 0) return null;
            const m = META[cat];
            return (
              <div key={cat} className={`rounded-xl border ${m.cls} p-3`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full ${m.dot}`} />
                  <span className="text-sm font-semibold text-gray-800">{m.label}</span>
                  <span className="text-xs text-gray-500">({list.length})</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">{m.hint}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 text-left border-b border-gray-200/60">
                        {['订单', '客户', '交期', '拖红的节点', ''].map((h) => <th key={h} className="px-2 py-1 font-medium whitespace-nowrap">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((it) => (
                        <tr key={it.id} className="border-b border-gray-100/60">
                          <td className="px-2 py-1.5 font-mono text-gray-800 whitespace-nowrap">{it.orderNo}{it.internalNo ? <span className="text-gray-400 ml-1">/{it.internalNo}</span> : null}</td>
                          <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{it.customer || '—'}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            <span className={it.daysToDelivery != null && it.daysToDelivery < 0 ? 'text-rose-600 font-medium' : 'text-gray-600'}>
                              {it.deliveryDate ? String(it.deliveryDate).slice(0, 10) : '—'}
                              {it.daysToDelivery != null && (it.daysToDelivery < 0 ? ` (超${-it.daysToDelivery}天)` : ` (剩${it.daysToDelivery}天)`)}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-gray-700">{culpritText(it.culprits)}</td>
                          <td className="px-2 py-1.5"><Link href={`/orders/${it.id}`} className="text-indigo-600 hover:underline whitespace-nowrap">详情›</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-gray-400">
            体检基于当前列表(受筛选影响)。「疑似没回填」是启发式判断——跟单核实后:实际做了的节点点「完成」;真没动的推进它。红牌随节点状态自动更新。
          </p>
        </div>
      )}
    </div>
  );
}
