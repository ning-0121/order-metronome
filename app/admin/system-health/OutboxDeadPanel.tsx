'use client';

/**
 * 财务同步死信面板(2026-08-19 P1 §10)。
 * 此前 outbox 重试耗尽(status='dead')只发一条通知让 admin「去 integration_outbox 表查」——
 * 全站没有任何页面能看到它,更没法重发。这里给 admin 一个列表 + 一键重新入队
 * (状态回 pending、attempts 归零,由既有 cron 重试通道接手;不在浏览器里直接重发)。
 */
import { useEffect, useState } from 'react';
import { listDeadOutbox, requeueDeadOutbox } from '@/app/actions/outbox-admin';

export function OutboxDeadPanel() {
  const [rows, setRows] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => listDeadOutbox().then((r: any) => { setRows(r.data || []); setLoaded(true); if (r.error) setMsg(r.error); });
  useEffect(() => { load(); }, []);

  async function requeue(id: string) {
    setBusy(true); setMsg('');
    const r: any = await requeueDeadOutbox(id);
    setBusy(false);
    if (r.error) { setMsg(r.error); return; }
    setMsg('已重新入队,cron 将按退避重试');
    load();
  }

  if (!loaded || rows.length === 0) return null;   // 无死信不占位
  return (
    <div className="mb-8 rounded-xl border border-red-200 bg-red-50/50 p-4">
      <p className="text-sm font-semibold text-red-800 mb-1">☠️ 财务同步死信({rows.length})—— 重试已耗尽,需人工处理</p>
      <p className="text-xs text-red-600 mb-3">重新入队后由既有 cron 重试;若反复死信,先查 last_error 与财务系统连通性。</p>
      {msg && <p className="text-xs font-medium text-amber-700 mb-2">{msg}</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg bg-white border border-red-100 px-3 py-2 flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">{r.event}</span>
            <span className="text-xs text-gray-500">尝试 {r.attempts} 次 · {String(r.created_at).slice(0, 16).replace('T', ' ')}</span>
            <span className="text-xs text-red-600 truncate max-w-md" title={r.last_error || ''}>{r.last_error || '(无错误信息)'}</span>
            <button onClick={() => requeue(r.id)} disabled={busy}
              className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50">重新入队</button>
          </div>
        ))}
      </div>
    </div>
  );
}
