'use client';

/**
 * 建单必传附件「补传」条(2026-07-11)。
 * 新规则要求建单必传 客户PO + 内部报价单,但规则上线前/no_po 建的单可能缺。
 * 授权人(创建者/负责人/业务经理/管理员)在订单详情补传;补传后即时共享财务(同建单口径),
 * 并即时出现在 PO确认节点内联附件里。缺才显示,齐了不显示。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { shareBuildDocsToFinance } from '@/app/actions/order-build-docs';

const LABELS: Record<string, string> = { customer_po: '客户PO', internal_quote: '内部报价单' };

export function BuildDocsSupplement({ orderId, missing }: { orderId: string; missing: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  async function upload(fileType: string, file: File) {
    setBusy(fileType); setMsg('');
    try {
      const supabase = createBrowserClient();
      const ext = file.name.split('.').pop() || 'bin';
      const storagePath = `${orderId}/${fileType}_${Date.now()}.${ext}`;   // 与建单同桶同路径规范
      const { error: upErr } = await supabase.storage
        .from('order-docs').upload(storagePath, file, { contentType: file.type, upsert: false });
      if (upErr) { setMsg('❌ 上传失败:' + upErr.message); setBusy(null); return; }
      const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(storagePath);
      const { data: { user } } = await supabase.auth.getUser();
      const { error: dbErr } = await (supabase.from('order_attachments') as any).insert({
        order_id: orderId, file_type: fileType, storage_path: storagePath,
        file_name: file.name, file_url: urlData?.publicUrl || storagePath,
        file_size: file.size, mime_type: file.type || null, uploaded_by: user?.id || null,
      });
      if (dbErr) { setMsg('❌ 记录保存失败:' + dbErr.message); setBusy(null); return; }
      // 即时共享财务(同建单口径:推 file.uploaded → 外部财务系统;财务审批PO时可见)
      try { await shareBuildDocsToFinance(orderId); } catch { /* 不阻断补传 */ }
      setMsg(`✅ ${LABELS[fileType] || fileType} 已补传并共享给财务`);
      router.refresh();
    } catch (e: any) {
      setMsg('❌ ' + (e?.message || String(e)));
    } finally { setBusy(null); }
  }

  if (!missing || missing.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
        ⚠️ 缺建单必传附件,请补传
      </div>
      <p className="mt-0.5 text-[11px] text-amber-700">
        本单建单时缺:{missing.map((t) => LABELS[t] || t).join('、')}。补传后即时共享给财务,财务审批PO时即可看到。
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {missing.map((t) => (
          <label key={t}
            className={`inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 cursor-pointer hover:bg-amber-100 ${busy === t ? 'opacity-50 pointer-events-none' : ''}`}>
            {busy === t ? '上传中…' : `📎 补传 ${LABELS[t] || t}`}
            <input type="file" accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(t, f); e.currentTarget.value = ''; }} />
          </label>
        ))}
      </div>
      {msg && <p className={`mt-2 text-xs ${msg.startsWith('✅') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</p>}
    </div>
  );
}
