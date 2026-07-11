'use client';

/**
 * 订单共享文件(只读下载)—— 业务在「原辅料和包装」页上传的「辅料采购清单」「包装方式」,
 * 在采购核料页 / 生产任务单页只读展示下载链接,让采购/生产在自己页面就能拿到。上传/删除仍在 BOM 页。
 */

import { useEffect, useState } from 'react';
import { listOrderShareDocs } from '@/app/actions/order-share-docs';

type Doc = { id: string; file_name: string; url: string | null };
const KINDS: Array<{ type: string; label: string; icon: string }> = [
  { type: 'accessory_purchase_list', label: '辅料采购清单', icon: '📋' },
  { type: 'packing_method', label: '包装方式', icon: '📦' },
];

export function OrderShareDocsLinks({ orderId, className = '' }: { orderId: string; className?: string }) {
  const [docs, setDocs] = useState<Record<string, Doc[]>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all(KINDS.map(k => listOrderShareDocs(orderId, k.type).then(r => [k.type, ((r as any).data || []) as Doc[]] as const)))
      .then(pairs => { if (alive) { setDocs(Object.fromEntries(pairs)); setLoaded(true); } });
    return () => { alive = false; };
  }, [orderId]);

  if (!loaded) return null;
  const total = KINDS.reduce((n, k) => n + (docs[k.type]?.length || 0), 0);
  if (total === 0) return null;   // 没有共享文件就不占位

  return (
    <div className={`rounded-xl border border-violet-200 bg-violet-50/40 p-3 ${className}`}>
      <p className="text-sm font-semibold text-gray-800 mb-2">📎 订单共享文件（业务在「原辅料和包装」上传）</p>
      <div className="space-y-2">
        {KINDS.map(k => {
          const list = docs[k.type] || [];
          if (list.length === 0) return null;
          return (
            <div key={k.type}>
              <p className="text-xs font-medium text-gray-600 mb-0.5">{k.icon} {k.label}</p>
              <div className="space-y-0.5 pl-4">
                {list.map(d => (
                  <div key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-400">📄</span>
                    {d.url
                      ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline truncate">{d.file_name}</a>
                      : <span className="text-gray-600 truncate">{d.file_name}</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
