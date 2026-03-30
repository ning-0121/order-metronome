'use client';

import { useState } from 'react';
import { verifyPOAgainstOrder } from '@/app/actions/po-verify';
import type { POVerifyResult } from '@/app/actions/po-verify';

interface Props {
  fileUrl: string;
  fileName: string;
  orderData: {
    quantity?: number | null;
    delivery_date?: string | null;
    customer_name?: string | null;
    style_no?: string | null;
    po_number?: string | null;
    order_no?: string;
  };
}

export function POVerifyButton({ fileUrl, fileName, orderData }: Props) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const [result, setResult] = useState<POVerifyResult | null>(null);
  const [error, setError] = useState('');

  async function handleVerify() {
    setStatus('loading');
    setError('');

    try {
      // 下载文件转 base64
      const res = await fetch(fileUrl);
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const fileType = blob.type || 'application/pdf';

      const verifyResult = await verifyPOAgainstOrder(base64, fileType, fileName, orderData);

      if (verifyResult.error) {
        setError(verifyResult.error);
        setStatus('idle');
      } else {
        setResult(verifyResult.data!);
        setStatus('done');
      }
    } catch (e: any) {
      setError(e.message || '比对失败');
      setStatus('idle');
    }
  }

  if (status === 'idle' && !result) {
    return (
      <button
        onClick={handleVerify}
        className="text-xs px-2.5 py-1.5 rounded-md border border-indigo-200 text-indigo-600 hover:bg-indigo-50 font-medium transition-colors"
      >
        AI 比对
      </button>
    );
  }

  if (status === 'loading') {
    return (
      <span className="text-xs text-gray-400 flex items-center gap-1">
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        比对中...
      </span>
    );
  }

  if (error) {
    return <span className="text-xs text-red-500">{error}</span>;
  }

  if (!result) return null;

  const hasDiff = result.differences.length > 0;

  return (
    <div className="mt-3">
      {/* 结果标题 */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg text-sm font-medium ${
        hasDiff ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
      }`}>
        <span>{hasDiff ? '⚠️' : '✅'}</span>
        <span>{hasDiff ? `发现 ${result.differences.length} 处差异，请核实` : 'PO 信息与订单一致'}</span>
      </div>

      {/* 差异列表 */}
      {result.differences.length > 0 && (
        <div className="border border-t-0 border-red-200 rounded-b-lg divide-y divide-red-100">
          {result.differences.map((d, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-4 text-xs">
              <span className={`px-1.5 py-0.5 rounded font-medium ${
                d.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
              }`}>
                {d.fieldLabel}
              </span>
              <div className="flex items-center gap-2 flex-1">
                <span className="text-gray-500">PO：</span>
                <span className="font-semibold text-red-600">{d.poValue}</span>
                <span className="text-gray-300">vs</span>
                <span className="text-gray-500">订单：</span>
                <span className="font-semibold text-gray-700">{d.orderValue}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 一致项 */}
      {result.matched.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {result.matched.map((m, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600">✓ {m}</span>
          ))}
        </div>
      )}

      {/* 重新比对 */}
      <button
        onClick={() => { setResult(null); setStatus('idle'); }}
        className="text-xs text-gray-400 hover:text-gray-600 mt-2"
      >
        重新比对
      </button>
    </div>
  );
}
