'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface PackingFile {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  created_at: string;
}

export function PackingFilesSection({ orderId }: { orderId: string }) {
  const [files, setFiles] = useState<PackingFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    // 查询该订单的包装相关附件（file_type = packing_requirement, trims_sheet, production_order）
    (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, created_at')
      .eq('order_id', orderId)
      .in('file_type', ['packing_requirement', 'trims_sheet', 'production_order', 'tech_pack'])
      .order('created_at', { ascending: false })
      .then(({ data }: any) => {
        setFiles(data || []);
        setLoading(false);
      });
  }, [orderId]);

  const typeLabels: Record<string, string> = {
    packing_requirement: '装箱要求',
    trims_sheet: '辅料表',
    production_order: '生产制单',
    tech_pack: 'Tech Pack',
  };

  if (loading) return <div className="text-sm text-gray-400 py-2">加载中...</div>;

  if (files.length === 0) {
    return (
      <div className="text-center py-6 text-gray-400 text-sm">
        <p>暂无包装资料</p>
        <p className="text-xs mt-1">业务在「生产单上传」节点上传的包装资料将显示在这里</p>
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
          {f.file_url && (
            <a href={f.file_url} target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-indigo-600 hover:bg-indigo-50 shrink-0">
              查看/下载
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
