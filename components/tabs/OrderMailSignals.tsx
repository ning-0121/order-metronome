'use client';

import { useEffect, useState } from 'react';
import { getOrderMailSignals, getOrderPOAttachments, type DigestRow, type POAttachmentRow } from '@/app/actions/mail-digest';

const CAT_STYLE: Record<string, string> = {
  投诉: 'bg-red-100 text-red-700 border-red-200',
  交期: 'bg-orange-100 text-orange-700 border-orange-200',
  样品: 'bg-violet-100 text-violet-700 border-violet-200',
};
const CAT_LABEL: Record<string, string> = { 投诉: '投诉/索赔', 交期: '交期/船期', 样品: '样品/打样' };

/** 订单页客户邮件信号(闭环 P3b):该订单的 投诉/交期/样品 邮件,空则不渲染。 */
export function OrderMailSignals({ orderId }: { orderId: string }) {
  const [rows, setRows] = useState<DigestRow[] | null>(null);
  const [pos, setPos] = useState<POAttachmentRow[]>([]);

  useEffect(() => {
    let alive = true;
    getOrderMailSignals(orderId).then((res) => { if (alive) setRows(res.data || []); });
    getOrderPOAttachments(orderId).then((res) => { if (alive) setPos(res.data || []); });
    return () => { alive = false; };
  }, [orderId]);

  const poDone = pos.filter((p) => p.extract_summary || p.ocr_status === 'done');
  const signalRows = rows || [];
  if (rows === null) return null;                       // 加载中
  if (signalRows.length === 0 && poDone.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-amber-200 p-4 mb-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-sm font-semibold text-amber-800">📌 客户邮件信号</span>
        <span className="text-xs text-gray-400">本订单的交期 / 投诉 / 样品反馈 + PO 附件</span>
      </div>

      {poDone.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {poDone.map((p) => {
            const h = p.extracted_json || {};
            return (
              <div key={p.id} className="text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] px-1.5 py-0.5 rounded border bg-blue-100 text-blue-700 border-blue-200">📎 PO 附件</span>
                  {p.file_name && <span className="text-[11px] text-gray-400 truncate">{p.file_name}</span>}
                </div>
                <div className="text-gray-800 leading-snug mt-1">{p.extract_summary || '(已提取,见要点)'}</div>
                {(h.po_number || h.delivery_date || h.total_quantity) && (
                  <div className="text-[12px] text-gray-500 mt-1 flex gap-3 flex-wrap">
                    {h.po_number && <span>PO: <b className="text-gray-700">{h.po_number}</b></span>}
                    {h.delivery_date && <span>交期: <b className="text-gray-700">{h.delivery_date}</b></span>}
                    {h.total_quantity != null && <span>总量: <b className="text-gray-700">{h.total_quantity}</b></span>}
                    {h.style_count != null && <span>{h.style_count} 款</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {signalRows.map((r) => {
          const handled = r.handled_status === 'handled' || r.handled_status === 'ignored';
          return (
            <div key={r.id} className={`flex items-start gap-2.5 text-sm ${handled ? 'opacity-45' : ''}`}>
              <span className={`inline-block w-2 h-2 rounded-full mt-1.5 shrink-0 ${(r.importance ?? 0) >= 3 ? 'bg-red-500' : (r.importance ?? 0) === 2 ? 'bg-amber-500' : 'bg-gray-300'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {r.category && (
                    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${CAT_STYLE[r.category] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                      {CAT_LABEL[r.category] || r.category}
                    </span>
                  )}
                  {r.needs_action && !handled && <span className="text-[11px] text-amber-700">⚑ {r.action_type || '待处理'}</span>}
                  {handled && <span className="text-[11px] text-gray-400">已处理</span>}
                  <span className="text-[11px] text-gray-400">{new Date(r.received_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>
                </div>
                <div className="text-gray-800 leading-snug mt-0.5">{r.summary || r.subject}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
