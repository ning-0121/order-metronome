'use client';

import { useState, useEffect } from 'react';
import { assignMerchandiser } from '@/app/actions/milestones';
import { getMerchandiserCandidates } from '@/app/actions/commissions';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  currentMerchandiserName?: string | null;
}

export function MerchandiserAssign({ orderId, currentMerchandiserName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    if (open && candidates.length === 0) {
      getMerchandiserCandidates().then(res => {
        if (res.data) setCandidates(res.data);
      });
    }
  }, [open, candidates.length]);

  async function handleAssign() {
    if (!selectedId) return;
    setLoading(true);
    const result = await assignMerchandiser(orderId, selectedId);
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
    <div className="flex items-center gap-2">
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
      <button
        onClick={() => setOpen(false)}
        className="text-xs text-gray-400 hover:text-gray-600"
      >
        取消
      </button>
    </div>
  );
}
