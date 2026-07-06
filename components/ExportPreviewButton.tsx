'use client';

/** 通用「先预览再下载」导出按钮:点按钮 → 拉数据弹窗预览(表格)→ 弹窗内「下载 Excel」。 */

import { useState } from 'react';

export type ExportResult = { base64?: string; fileName?: string; headers?: string[]; rows?: (string | number)[][]; error?: string };

export function ExportPreviewButton({ label, className, fetcher }: {
  label: string; className?: string; fetcher: () => Promise<ExportResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<ExportResult | null>(null);

  async function loadPreview() {
    setBusy(true); setErr('');
    try {
      const res = await fetcher();
      if (res.error) { setErr(res.error); return; }
      setPreview(res);
    } catch { setErr('加载失败'); } finally { setBusy(false); }
  }

  function download() {
    if (!preview?.base64) return;
    const bytes = atob(preview.base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = preview.fileName || '导出.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <span className="inline-flex flex-col items-end">
        <button onClick={loadPreview} disabled={busy} className={className}>
          {busy ? '加载中…' : label}
        </button>
        {err && <span className="mt-1 text-[11px] text-red-600">{err}</span>}
      </span>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-5xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-gray-800">预览 · {preview.rows?.length || 0} 行</span>
              <div className="flex gap-2">
                <button onClick={download} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700">⬇ 下载 Excel</button>
                <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50">关闭</button>
              </div>
            </div>
            <div className="overflow-auto p-3">
              {(preview.rows?.length || 0) === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">没有数据</p>
              ) : (
                <table className="w-full text-xs whitespace-nowrap">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>{(preview.headers || []).map((h, i) => <th key={i} className="px-2 py-1.5 text-left font-medium border-b border-gray-200">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(preview.rows || []).slice(0, 500).map((r, ri) => (
                      <tr key={ri} className="border-b border-gray-50 hover:bg-gray-50">
                        {r.map((c, ci) => <td key={ci} className="px-2 py-1 text-gray-700">{String(c)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(preview.rows?.length || 0) > 500 && <p className="text-[11px] text-gray-400 mt-2">仅预览前 500 行,下载 Excel 为全部。</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
