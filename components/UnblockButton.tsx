'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { markMilestoneUnblocked } from '@/app/actions/milestones';

interface UnblockButtonProps {
  milestoneId: string;
}

export function UnblockButton({ milestoneId }: UnblockButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleUnblock() {
    setLoading(true);
    const result = await markMilestoneUnblocked(milestoneId);
    if (!result.error) {
      router.refresh();
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  return (
    <button
      onClick={handleUnblock}
      disabled={loading}
      className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm font-medium disabled:opacity-50"
    >
      {loading ? '处理中...' : '解除卡住'}
    </button>
  );
}
