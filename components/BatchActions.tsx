'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getMerchandiserCandidates } from '@/app/actions/commissions';
import { assignMerchandiser } from '@/app/actions/milestones';

interface Props {
  orderIds: string[];
  isAdmin: boolean;
  currentRoles: string[];
}

export function BatchActions({ orderIds, isAdmin, currentRoles }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showToolbar, setShowToolbar] = useState(false);
  const [action, setAction] = useState<'assign' | 'nudge' | null>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState('');

  const canBatch = isAdmin || currentRoles.includes('production_manager');

  useEffect(() => {
    setShowToolbar(selected.size > 0);
  }, [selected]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === orderIds.length) setSelected(new Set());
    else setSelected(new Set(orderIds));
  }

  async function openAssign() {
    setAction('assign');
    if (candidates.length === 0) {
      const res = await getMerchandiserCandidates();
      setCandidates(res.data || []);
    }
  }

  async function executeBatchAssign() {
    if (!selectedUser) return;
    setExecuting(true);
    setResult('');
    let success = 0;
    for (const orderId of selected) {
      const res = await assignMerchandiser(orderId, selectedUser);
      if (!res.error) success++;
    }
    setResult(`成功分配 ${success}/${selected.size} 个订单`);
    setExecuting(false);
    setSelected(new Set());
    setAction(null);
    router.refresh();
  }

  async function executeBatchNudge() {
    setExecuting(true);
    setResult('');
    let success = 0;
    for (const orderId of selected) {
      try {
        await fetch('/api/nudge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, message: '[批量催办] 请尽快处理超期节点' }),
        });
        success++;
      } catch {}
    }
    setResult(`成功催办 ${success}/${selected.size} 个订单`);
    setExecuting(false);
    setSelected(new Set());
    setAction(null);
  }

  if (!canBatch) return null;

  return (
    <>
      {/* 全选按钮 */}
      <div className="flex items-center gap-3 mb-3">
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" checked={selected.size === orderIds.length && orderIds.length > 0}
            onChange={toggleAll} className="rounded border-gray-300" />
          {selected.size > 0 ? `已选 ${selected.size} 个` : '全选'}
        </label>
      </div>

      {/* 选择复选框注入（通过 CSS 类名匹配） */}
      <style>{`
        .batch-checkbox { display: inline-block; margin-right: 8px; }
        .batch-checkbox input { cursor: pointer; }
      `}</style>

      {/* 底部浮动操作栏 */}
      {showToolbar && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white rounded-2xl shadow-2xl border border-gray-200 px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">已选 {selected.size} 个订单</span>

          {action === null && (
            <>
              <button onClick={openAssign}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
                👤 批量分配跟单
              </button>
              <button onClick={() => { setAction('nudge'); executeBatchNudge(); }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700">
                📧 批量催办
              </button>
              <button onClick={() => { setSelected(new Set()); }}
                className="text-sm text-gray-400 hover:text-gray-600">取消</button>
            </>
          )}

          {action === 'assign' && (
            <div className="flex items-center gap-2">
              <select value={selectedUser} onChange={e => setSelectedUser(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                <option value="">选择跟单人员</option>
                {candidates.map((c: any) => (
                  <option key={c.user_id} value={c.user_id}>{c.name || c.email}</option>
                ))}
              </select>
              <button onClick={executeBatchAssign} disabled={executing || !selectedUser}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white disabled:opacity-50">
                {executing ? '分配中...' : '确认分配'}
              </button>
              <button onClick={() => setAction(null)} className="text-sm text-gray-400">取消</button>
            </div>
          )}

          {action === 'nudge' && executing && (
            <span className="text-sm text-amber-600">催办中...</span>
          )}

          {result && <span className="text-sm text-green-600">{result}</span>}
        </div>
      )}

      {/* 暴露选择状态给父组件（通过 DOM） */}
      {orderIds.map(id => (
        <input key={id} type="hidden" className="batch-select-state"
          data-order-id={id} data-selected={selected.has(id) ? '1' : '0'} />
      ))}
    </>
  );
}

/**
 * 单个订单行的复选框
 */
export function BatchCheckbox({ orderId, onChange }: { orderId: string; onChange: (id: string, checked: boolean) => void }) {
  return (
    <input type="checkbox" className="rounded border-gray-300 cursor-pointer"
      onChange={e => onChange(orderId, e.target.checked)} />
  );
}
