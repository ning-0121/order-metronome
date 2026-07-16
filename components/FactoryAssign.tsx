'use client';

import { useState, useEffect } from 'react';
import { getFactories, updateOrderFactory } from '@/app/actions/factories';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  currentFactoryName?: string | null;
}

/** 更换订单工厂(仅 admin / 生产主管可见渲染;操作侧服务端再校验一次)。 */
export function FactoryAssign({ orderId, currentFactoryName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [factories, setFactories] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open && factories.length === 0) {
      getFactories().then(res => { if (res.data) setFactories(res.data); });
    }
  }, [open, factories.length]);

  async function save() {
    setLoading(true); setErr('');
    if (!reason.trim()) { setErr('请填写定厂/换厂原因'); setLoading(false); return; }
    const res = await updateOrderFactory(orderId, selectedId || null, reason);
    setLoading(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    setOpen(false); router.refresh();
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{currentFactoryName || <span className="text-gray-400">未指定</span>}</span>
        <button onClick={() => setOpen(true)} className="text-xs text-indigo-600 hover:text-indigo-800">
          {currentFactoryName ? '更换' : '指定'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white max-w-[180px]">
          <option value="">选择工厂</option>
          {factories.map((f: any) => (
            <option key={f.id} value={f.id}>{f.factory_name}{f.factory_code ? ` (${f.factory_code})` : ''}</option>
          ))}
        </select>
        <button onClick={save} disabled={loading} className="text-xs px-2 py-1 rounded bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">{loading ? '保存中…' : '保存'}</button>
        <button onClick={() => { setOpen(false); setErr(''); }} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
      </div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="必填：定厂/换厂原因"
        className="w-full max-w-[280px] rounded border border-gray-300 px-2 py-1 text-xs" />
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}
