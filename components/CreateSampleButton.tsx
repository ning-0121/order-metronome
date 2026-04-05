'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSampleFromQuote } from '@/app/actions/quotes';

export function CreateSampleButton({ quoteOrderId, orderNo }: { quoteOrderId: string; orderNo: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!confirm(`确认从报价 ${orderNo} 创建打样单？`)) return;
    setLoading(true);
    const result = await createSampleFromQuote(quoteOrderId);
    if (result.error) {
      alert(result.error);
    } else if (result.sampleId) {
      router.push(`/orders/${result.sampleId}`);
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <button onClick={handleCreate} disabled={loading}
      className="text-xs px-3 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 font-medium">
      {loading ? '创建中...' : '🧪 创建打样单'}
    </button>
  );
}
