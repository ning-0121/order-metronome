'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function BomTab({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    createClient().from('materials_bom').select('*')
      .eq('order_id', orderId).order('material_type')
      .then(({ data }) => { setItems(data || []); setLoading(false); });
  }, [orderId]);

  const typeLabels: Record<string, string> = {
    fabric: '面料', trim: '辅料', lining: '里料',
    label: '标签', packing: '包装', other: '其他',
  };

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!items.length) return (
    <div className="text-center py-12 text-gray-400">
      <p className="mb-2">暂无 BOM 数据</p>
      <p className="text-sm">可由采购/管理员录入面辅料清单</p>
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            {['物料代码','物料名称','类型','单件用量','总需用量','单位','供应商'].map(h => (
              <th key={h} className={`py-2 px-3 text-gray-500 font-medium ${h==='单件用量'||h==='总需用量' ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="py-3 px-3 font-mono text-gray-600 text-xs">{item.material_code}</td>
              <td className="py-3 px-3 font-medium text-gray-900">{item.material_name}</td>
              <td className="py-3 px-3">
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                  {typeLabels[item.material_type] || item.material_type}
                </span>
              </td>
              <td className="py-3 px-3 text-right text-gray-700">{item.qty_per_piece}</td>
              <td className="py-3 px-3 text-right font-medium text-gray-900">{item.total_qty ?? '—'}</td>
              <td className="py-3 px-3 text-gray-600">{item.unit}</td>
              <td className="py-3 px-3 text-gray-500">{item.supplier || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
