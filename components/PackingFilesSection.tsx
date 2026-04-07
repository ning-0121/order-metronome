'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { deleteAttachment, getAttachmentDownloadUrl } from '@/app/actions/attachments';

interface PackingFile {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  created_at: string;
}

interface Props {
  orderId: string;
  fileTypes?: string[];
  emptyText?: string;
  /** 是否允许删除（默认 true — 由订单页根据角色判断后传入） */
  canDelete?: boolean;
}

export function PackingFilesSection({ orderId, fileTypes, emptyText, canDelete = true }: Props) {
  const [files, setFiles] = useState<PackingFile[]>([]);
  const [loading, setLoading] = useState(true);

  const types = fileTypes || ['packing_requirement', 'trims_sheet', 'production_order', 'tech_pack'];

  useEffect(() => {
    const supabase = createClient();
    (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, created_at')
      .eq('order_id', orderId)
      .in('file_type', types)
      .order('created_at', { ascending: false })
      .then(({ data }: any) => { setFiles(data || []); setLoading(false); });
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete(f: PackingFile) {
    if (!confirm(`确定删除「${f.file_name}」？此操作不可恢复。`)) return;
    const res = await deleteAttachment(f.id, orderId);
    if (res.error) { alert(res.error); return; }
    setFiles(prev => prev.filter(x => x.id !== f.id));
  }

  // P1 修复：用临时签名 URL 代替永久 public URL
  async function handleDownload(f: PackingFile) {
    const res = await getAttachmentDownloadUrl(f.id);
    if (res.error) { alert(res.error); return; }
    if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
  }

  const typeLabels: Record<string, string> = {
    packing_requirement: '包装资料',
    trims_sheet: '原辅料单',
    production_order: '生产制单',
    tech_pack: 'Tech Pack',
  };

  if (loading) return <div className="text-sm text-gray-400 py-2">加载中...</div>;

  if (files.length === 0) {
    return (
      <div className="text-center py-4 text-gray-400 text-sm">
        <p>{emptyText || '暂无文件'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {files.map(f => (
        <div key={f.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-lg">📎</span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{f.file_name || '未命名文件'}</p>
              <p className="text-xs text-gray-400">
                {typeLabels[f.file_type] || f.file_type} · {new Date(f.created_at).toLocaleDateString('zh-CN')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleDownload(f)}
              className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-indigo-600 hover:bg-indigo-50"
            >
              查看/下载
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={() => handleDelete(f)}
                className="text-xs px-3 py-1.5 rounded-lg bg-white border border-red-200 text-red-600 hover:bg-red-50"
                title="删除"
              >
                删除
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
