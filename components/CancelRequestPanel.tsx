'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCancelRequests, decideCancelAction } from '@/app/actions/orders';

const REASON_LABELS: Record<string, string> = {
  customer_cancel: '客户取消',
  pricing_issue: '价格问题',
  capacity_issue: '产能问题',
  risk_control: '风控',
  other: '其他',
};

interface Props {
  orderId: string;
  isAdmin: boolean;
}

/**
 * 取消订单申请 — 待审批横幅 + 管理员审批入口。
 * 业务提交 requestCancel 后，订单页顶部出现此横幅；管理员可批准/拒绝（decideCancelAction）。
 * 无 pending 申请时不渲染。
 */
export function CancelRequestPanel({ orderId, isAdmin }: Props) {
  const router = useRouter();
  const [requests, setRequests] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function load() {
    const res = await getCancelRequests(orderId);
    if ((res as any)?.data) setRequests((res as any).data);
    setLoaded(true);
  }

  const pending = requests.filter((r) => r.status === 'pending');
  if (!loaded || pending.length === 0) return null;

  async function decide(id: string, decision: 'approved' | 'rejected') {
    let note: string | null = null;
    if (decision === 'approved') {
      if (!confirm('确认批准取消该订单？批准后订单将标记为「已取消」，并同步财务系统。')) return;
    } else {
      note = prompt('拒绝原因（可选）：');
      if (note === null) return; // 用户点了取消
    }
    setBusy(id);
    const res = await decideCancelAction(id, decision, note);
    setBusy(null);
    if ((res as any)?.error) {
      alert((res as any).error);
      return;
    }
    alert(decision === 'approved' ? '✅ 已批准取消，订单已标记为已取消' : '已拒绝该取消申请');
    router.refresh();
    load();
  }

  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-5 py-4 mb-4 space-y-3">
      {pending.map((r) => (
        <div key={r.id} className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-800">🛑 取消订单申请 · 待审批</p>
            <p className="text-sm text-red-700 mt-1">
              原因：{REASON_LABELS[r.reason_type] || r.reason_type}
              {r.reason_detail ? ` — ${r.reason_detail}` : ''}
            </p>
            <p className="text-xs text-red-500 mt-1">提交于 {String(r.created_at).slice(0, 10)}</p>
          </div>
          {isAdmin ? (
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => decide(r.id, 'approved')}
                disabled={busy === r.id}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-all"
              >
                {busy === r.id ? '处理中…' : '批准取消'}
              </button>
              <button
                onClick={() => decide(r.id, 'rejected')}
                disabled={busy === r.id}
                className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-all"
              >
                拒绝
              </button>
            </div>
          ) : (
            <span className="text-xs text-red-600 self-center">等待管理员审批</span>
          )}
        </div>
      ))}
    </div>
  );
}
