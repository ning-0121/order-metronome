'use client';

import { useEffect, useState } from 'react';
import { getLogisticsSubtasks, toggleLogisticsSubtask, saveLogisticsSubtaskAttachments, type LogisticsSubtask } from '@/app/actions/logistics';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { compressImageForUpload } from '@/lib/utils/image-compress';

/**
 * 出运子任务清单:物流逐项勾(出口=装柜/报关放行/拖柜送港/开船;国内=内陆送货/送仓签收)+ 每项传多张出货凭证。
 * canOperate=true 才能勾/传(物流/管理);否则只读展示进度+凭证。
 */
export function LogisticsSubtaskChecklist({ orderId, canOperate }: { orderId: string; canOperate: boolean }) {
  const [tasks, setTasks] = useState<LogisticsSubtask[]>([]);
  const [isDomestic, setIsDomestic] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  async function load() {
    const r = await getLogisticsSubtasks(orderId);
    setTasks(r.data || []);
    setIsDomestic(!!r.isDomestic);
    setLoading(false);
  }
  useEffect(() => { load(); }, [orderId]);

  async function toggle(t: LogisticsSubtask) {
    if (!canOperate) return;
    setBusyId(t.id);
    const r = await toggleLogisticsSubtask(t.id, t.status !== 'done');
    setBusyId(null);
    if (!r.error) await load();
  }

  async function onUpload(t: LogisticsSubtask, files: FileList) {
    if (!canOperate || !files.length) return;
    setUploadingId(t.id);
    try {
      const supabase = createBrowserClient();
      const added: Array<{ name: string; url: string }> = [];
      for (const f of Array.from(files)) {
        try {
          const { blob, ext, type } = await compressImageForUpload(f);
          const path = `logistics/${orderId}/${t.task_key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const { error } = await supabase.storage.from('product-images').upload(path, blob, { contentType: type, upsert: false });
          if (error) continue;
          const { data } = supabase.storage.from('product-images').getPublicUrl(path);
          if (data?.publicUrl) added.push({ name: f.name, url: data.publicUrl });
        } catch { /* 单张失败跳过 */ }
      }
      if (added.length) {
        const merged = [...(t.attachments || []), ...added];
        await saveLogisticsSubtaskAttachments(t.id, merged);
        await load();
      }
    } finally { setUploadingId(null); }
  }

  async function removeAttachment(t: LogisticsSubtask, url: string) {
    if (!canOperate) return;
    const merged = (t.attachments || []).filter((a) => a.url !== url);
    await saveLogisticsSubtaskAttachments(t.id, merged);
    await load();
  }

  if (loading) return <div className="text-xs text-gray-400 py-2">加载出运子任务…</div>;
  if (!tasks.length) return null;

  const doneCount = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-semibold text-sky-900">🚚 出运子任务（{isDomestic ? '国内送仓' : '出口出运'}）</span>
        <span className="text-xs text-gray-500">{doneCount}/{tasks.length} 完成</span>
        {!canOperate && <span className="text-xs text-gray-400">(仅物流/管理可勾/传凭证)</span>}
      </div>
      <div className="space-y-2.5">
        {tasks.map((t) => {
          const done = t.status === 'done';
          const atts = t.attachments || [];
          return (
            <div key={t.id} className="rounded-lg bg-white border border-gray-100 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label className={`flex items-center gap-2 text-sm ${canOperate ? 'cursor-pointer' : ''}`}>
                  <input type="checkbox" checked={done} disabled={!canOperate || busyId === t.id} onChange={() => toggle(t)} className="accent-sky-600" />
                  <span className={done ? 'text-gray-400 line-through' : 'text-gray-800 font-medium'}>{t.label}</span>
                </label>
                {done && t.done_at && <span className="text-xs text-emerald-600">✓ {String(t.done_at).slice(0, 10)}</span>}
                {busyId === t.id && <span className="text-xs text-gray-400">…</span>}
                {canOperate && (
                  <label className="ml-auto text-xs text-sky-700 hover:underline cursor-pointer whitespace-nowrap">
                    {uploadingId === t.id ? '上传中…' : '📎 传出货凭证'}
                    <input type="file" accept="image/*,application/pdf" multiple className="hidden"
                      disabled={uploadingId === t.id}
                      onChange={(e) => { if (e.target.files) onUpload(t, e.target.files); e.currentTarget.value = ''; }} />
                  </label>
                )}
              </div>
              {atts.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
                  {atts.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">
                      <a href={a.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline max-w-[160px] truncate">{a.name || `凭证${i + 1}`}</a>
                      {canOperate && <button onClick={() => removeAttachment(t, a.url)} className="text-gray-300 hover:text-red-500" title="移除">×</button>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
