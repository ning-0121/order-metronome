'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { markMilestoneUnblocked } from '@/app/actions/milestones';

interface UnblockButtonProps {
  milestoneId: string;
  /** 自定义样式。不传 = 工作台的全宽大按钮(原样式,勿改:app/dashboard/page.tsx 依赖它) */
  className?: string;
}

const DEFAULT_CLASS =
  'w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm font-medium disabled:opacity-50';

export function UnblockButton({ milestoneId, className }: UnblockButtonProps) {
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
      className={className || DEFAULT_CLASS}
    >
      {loading ? '处理中...' : '解除卡住'}
    </button>
  );
}
