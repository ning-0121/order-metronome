'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listPendingPriceApprovals, approvePriceApproval } from '@/app/actions/price-approvals';

interface Approval {
  id: string;
  customer_name: string | null;
  po_number: string | null;
  form_snapshot: any;
  price_diffs: any[];
  summary: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: string;
  expires_at: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  requester: { name?: string; email?: string } | null;
}

const STATUS_CFG: Record<string, { label: string; color: string }> = {
  pending: { label: '待审批', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  approved: { label: '已批准', color: 'bg-green-100 text-green-800 border-green-200' },
  rejected: { label: '已驳回', color: 'bg-red-100 text-red-800 border-red-200' },
  expired: { label: '已过期', color: 'bg-gray-100 text-gray-600 border-gray-200' },
};

export default function PriceApprovalsPage() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  async function load() {
    setLoading(true);
    setError('');
    const res = await listPendingPriceApprovals();
    if (res.error) setError(res.error);
    else setItems((res.data || []) as Approval[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDecide(id: string, decision: 'approved' | 'rejected') {
    const note = prompt(decision === 'approved' ? 'CEO 批准备注（可留空）' : '驳回原因（必填）') || '';
    if (decision === 'rejected' && !note) { alert('驳回必须填写原因'); return; }
    const res = await approvePriceApproval(id, decision, note);
    if (res.error) { alert(res.error); return; }
    load();
  }

  const visible = filter === 'pending' ? items.filter(i => i.status === 'pending') : items;
  const stats = {
    pending: items.filter(i => i.status === 'pending').length,
    approved: items.filter(i => i.status === 'approved').length,
    rejected: items.filter(i => i.status === 'rejected').length,
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/ceo" className="text-sm text-gray-500 hover:underline">← 返回 CEO 战情室</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">💰 价格审批 — 订单创建前</h1>
          <p className="text-sm text-gray-500 mt-1">
            业务员推送过来的「内部报价 ≠ 客户报价 ≠ 客户PO」价格不一致申请。批准后业务员才能继续创建订单。
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => setFilter('pending')}
            className={`px-3 py-1.5 rounded-lg border ${filter === 'pending' ? 'bg-amber-50 border-amber-300 text-amber-800 font-medium' : 'border-gray-200 text-gray-500'}`}
          >
            待审批 ({stats.pending})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-lg border ${filter === 'all' ? 'bg-gray-100 border-gray-300 font-medium' : 'border-gray-200 text-gray-500'}`}
          >
            全部 ({items.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-center py-8">加载中...</p>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center">
          <p className="text-2xl mb-2">✅</p>
          <p className="text-green-800 font-medium">{filter === 'pending' ? '没有待审批的价格申请' : '暂无价格审批记录'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map(it => {
            const cfg = STATUS_CFG[it.status];
            const expired = it.expires_at && new Date(it.expires_at) < new Date();
            const snap = it.form_snapshot || {};
            return (
              <div key={it.id} className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${cfg.color}`}>
                        {cfg.label}
                      </span>
                      {expired && it.status === 'pending' && (
                        <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-600">⏰ 已过期</span>
                      )}
                      <span className="text-xs text-gray-400">
                        {new Date(it.created_at).toLocaleString('zh-CN')}
                      </span>
                      <span className="text-xs text-gray-500">
                        申请人：{it.requester?.name || it.requester?.email || '—'}
                      </span>
                    </div>
                    <p className="text-base font-semibold text-gray-900">
                      {it.customer_name || '未知客户'} · PO {it.po_number || '—'}
                    </p>
                    {it.summary && (
                      <p className="text-sm text-gray-600 mt-1">{it.summary}</p>
                    )}
                  </div>
                  {it.status === 'pending' && !expired && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleDecide(it.id, 'approved')}
                        className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700"
                      >
                        ✓ 批准
                      </button>
                      <button
                        onClick={() => handleDecide(it.id, 'rejected')}
                        className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
                      >
                        ✕ 驳回
                      </button>
                    </div>
                  )}
                </div>

                {/* 表单快照 */}
                <div className="grid grid-cols-3 gap-2 text-xs bg-gray-50 rounded-lg p-3 mb-3">
                  {snap.quantity && <div><span className="text-gray-400">数量：</span>{snap.quantity}</div>}
                  {snap.unit_price && <div><span className="text-gray-400">单价：</span>{snap.unit_price}</div>}
                  {snap.total_amount && <div><span className="text-gray-400">总金额：</span>{snap.total_amount}</div>}
                  {snap.incoterm && <div><span className="text-gray-400">条款：</span>{snap.incoterm}</div>}
                  {snap.factory_name && <div><span className="text-gray-400">工厂：</span>{snap.factory_name}</div>}
                  {snap.factory_date && <div><span className="text-gray-400">出厂：</span>{snap.factory_date}</div>}
                </div>

                {/* 价格差异表 */}
                {Array.isArray(it.price_diffs) && it.price_diffs.length > 0 && (
                  <div className="rounded-lg border border-red-200 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-red-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-red-700">字段</th>
                          <th className="text-left px-3 py-2 font-medium text-red-700">内部报价</th>
                          <th className="text-left px-3 py-2 font-medium text-red-700">客户报价</th>
                          <th className="text-left px-3 py-2 font-medium text-red-700">客户 PO</th>
                          <th className="text-left px-3 py-2 font-medium text-red-700">说明</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100">
                        {(it.price_diffs as any[]).map((d, i) => (
                          <tr key={i} className="bg-white">
                            <td className="px-3 py-2 font-medium text-gray-900">{d.field}</td>
                            <td className="px-3 py-2 text-gray-700">{d.internalValue || '—'}</td>
                            <td className="px-3 py-2 text-gray-700">{d.customerQuoteValue || '—'}</td>
                            <td className="px-3 py-2 text-gray-700">{d.poValue || '—'}</td>
                            <td className="px-3 py-2 text-gray-500">{d.note || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {it.review_note && (
                  <div className="mt-3 text-xs text-gray-500 italic">
                    审批备注：{it.review_note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
