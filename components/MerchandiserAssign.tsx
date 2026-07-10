'use client';

import { useState, useEffect } from 'react';
import { assignMerchandiser } from '@/app/actions/milestones';
import { getMerchandiserCandidates } from '@/app/actions/commissions';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  currentMerchandiserName?: string | null;
  /** 'merchandiser'=业务执行(理单) | 'production'=生产跟单/QC。决定候选人范围与派单节点。 */
  kind?: 'merchandiser' | 'production';
}

export function MerchandiserAssign({ orderId, currentMerchandiserName, kind = 'merchandiser' }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  // 候选人加载态(修 P3 2026-07-09:此前只 if(res.data),失败/空态无反馈、且空态每次 open 重复请求 → 用户以为死了)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');

  useEffect(() => {
    if (!open || fetchState !== 'idle') return;
    setFetchState('loading');
    getMerchandiserCandidates(kind)
      .then(res => { setCandidates((res as any).data || []); setFetchState((res as any).error ? 'error' : 'ready'); })
      .catch(() => setFetchState('error'));
  }, [open, fetchState, kind]);

  async function handleAssign() {
    if (!selectedId) return;
    setLoading(true);
    const result = await assignMerchandiser(orderId, selectedId, kind);
    if (result.error) {
      alert(result.error);
    } else {
      setOpen(false);
      router.refresh();
    }
    setLoading(false);
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-900">
          {currentMerchandiserName || <span className="text-gray-400">未指定</span>}
        </span>
        <button
          onClick={() => setOpen(true)}
          className="text-xs text-indigo-600 hover:text-indigo-800"
        >
          {currentMerchandiserName ? '更换' : '指定'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {fetchState === 'loading' ? (
        <span className="text-xs text-gray-400">加载候选人…</span>
      ) : fetchState === 'error' ? (
        <span className="text-xs text-red-600">加载候选人失败,请刷新重试</span>
      ) : candidates.length === 0 ? (
        <span className="text-xs text-amber-600">无可指派的跟单人员(该类型下无符合角色的用户,请先在用户管理设角色)</span>
      ) : (
        <>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white"
          >
            <option value="">选择跟单人员</option>
            {candidates.map((c: any) => (
              <option key={c.user_id} value={c.user_id}>
                {c.name || c.email}
              </option>
            ))}
          </select>
          <button
            onClick={handleAssign}
            disabled={loading || !selectedId}
            className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? '...' : '确认'}
          </button>
        </>
      )}
      <button
        onClick={() => setOpen(false)}
        className="text-xs text-gray-400 hover:text-gray-600"
      >
        取消
      </button>
    </div>
  );
}
