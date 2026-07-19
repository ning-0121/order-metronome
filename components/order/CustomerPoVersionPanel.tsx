'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { getAttachmentDownloadUrl } from '@/app/actions/attachments';
import { replaceCustomerPo, withdrawCustomerPoVersion } from '@/app/actions/customer-po';

type VersionRow = {
  id: string;
  version: number;
  status: 'active' | 'superseded' | 'withdrawn';
  file_name: string | null;
  uploaded_by_name?: string | null;
  uploaded_by: string | null;
  created_at: string | null;
  replacement_reason?: string | null;
  withdrawn_reason?: string | null;
};

export function CustomerPoVersionPanel({
  orderId,
  versions,
  activeVersionId,
  canManage,
}: {
  orderId: string;
  versions: VersionRow[];
  activeVersionId: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeVersion = useMemo(
    () => versions.find((row) => row.id === activeVersionId) || versions.find((row) => row.status === 'active') || null,
    [activeVersionId, versions],
  );

  async function previewOrDownload(versionId: string) {
    setBusyId(versionId);
    const target = versions.find((row) => row.id === versionId);
    if (!target) {
      setBusyId(null);
      return;
    }
    const res = await getAttachmentDownloadUrl(versionId);
    setBusyId(null);
    if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
    else setMsg(res.error || '无法打开文件');
  }

  async function submitReplace() {
    if (!file) {
      setMsg('请选择新版 PO 文件');
      return;
    }
    if (reason.trim().length < 3) {
      setMsg('请填写更换原因');
      return;
    }
    setMsg('');
    const fd = new FormData();
    fd.set('file', file);
    fd.set('reason', reason.trim());
    const res = await replaceCustomerPo(orderId, fd);
    if (res.error) {
      setMsg(res.error);
      return;
    }
    setFile(null);
    setReason('');
    setMsg(res.warning || '新版 PO 已生效');
    startTransition(() => router.refresh());
  }

  async function withdraw(versionId: string) {
    const target = versions.find((row) => row.id === versionId);
    if (!target) return;
    const confirmReason = window.prompt(`撤回 PO v${target.version} 的原因`);
    if (!confirmReason || confirmReason.trim().length < 3) return;
    setBusyId(versionId);
    const res = await withdrawCustomerPoVersion(orderId, versionId, confirmReason.trim());
    setBusyId(null);
    if (res.error) {
      setMsg(res.error);
      return;
    }
    setMsg('已撤回该版本');
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">客户 PO 版本</h3>
          <p className="mt-1 text-xs text-slate-500">保留历史版本，当前只认一个有效版本；旧版不物理删除。</p>
        </div>
        {activeVersion && (
          <div className="text-right text-xs text-slate-500">
            <div className="font-medium text-emerald-700">当前有效：v{activeVersion.version}</div>
            <div>{activeVersion.file_name || '—'}</div>
            <div>{activeVersion.uploaded_by_name || '—'} · {activeVersion.created_at ? new Date(activeVersion.created_at).toLocaleString() : '—'}</div>
          </div>
        )}
      </div>

      {canManage && (
        <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">新版 PO 文件</span>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">替换原因</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：客户更新交期/数量/版式"
              className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              disabled={isPending}
              onClick={submitReplace}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending ? '保存中…' : '更换 PO'}
            </button>
          </div>
        </div>
      )}

      {msg && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{msg}</div>}

      <div className="space-y-2">
        {versions.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
            暂无客户 PO 版本
          </div>
        ) : versions.map((version) => (
          <div key={version.id} className={`rounded-lg border px-3 py-3 ${version.status === 'active' ? 'border-emerald-300 bg-emerald-50/60' : version.status === 'withdrawn' ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <span>v{version.version}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    version.status === 'active'
                      ? 'bg-emerald-100 text-emerald-700'
                      : version.status === 'withdrawn'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600'
                  }`}>
                    {version.status === 'active' ? '当前有效' : version.status === 'withdrawn' ? '已撤回' : '已替换'}
                  </span>
                </div>
                <div className="mt-1 text-sm text-slate-700 truncate">{version.file_name || '未命名文件'}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {version.uploaded_by_name || '—'} · {version.created_at ? new Date(version.created_at).toLocaleString() : '—'}
                </div>
                {version.replacement_reason && (
                  <div className="mt-1 text-xs text-slate-500">替换原因：{version.replacement_reason}</div>
                )}
                {version.withdrawn_reason && (
                  <div className="mt-1 text-xs text-slate-500">撤回原因：{version.withdrawn_reason}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === version.id}
                  onClick={() => previewOrDownload(version.id)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {busyId === version.id ? '打开中…' : '预览/下载'}
                </button>
                {canManage && version.status === 'active' && (
                  <button
                    type="button"
                    disabled={busyId === version.id}
                    onClick={() => withdraw(version.id)}
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    撤回当前版本
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

