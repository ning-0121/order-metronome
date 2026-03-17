'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function PackingTab({ orderId, isAdmin }: { orderId: string; isAdmin: boolean }) {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    createClient().from('packing_lists')
      .select('*, packing_list_lines(*)')
      .eq('order_id', orderId).order('created_at', { ascending: false })
      .then(({ data }) => { setLists(data || []); setLoading(false); });
  }, [orderId]);

  const statusConfig: Record<string, { label: string; cls: string }> = {
    draft: { label: '草稿', cls: 'bg-gray-100 text-gray-600' },
    confirmed: { label: '已确认', cls: 'bg-blue-100 text-blue-700' },
    locked: { label: '已锁定', cls: 'bg-green-100 text-green-700' },
  };

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!lists.length) return <div className="text-center py-12 text-gray-400">暂无装箱单</div>;

  return (
    <div className="space-y-6">
      {lists.map(pl => {
        const st = statusConfig[pl.status] || { label: pl.status, cls: 'bg-gray-100 text-gray-600' };
        return (
          <div key={pl.id} className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <span className="font-medium text-gray-900">{pl.pl_number || 'PL-' + pl.id.slice(0, 8)}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
              </div>
              <div className="flex gap-4 text-sm text-gray-500">
                <span>总箱数：<strong className="text-gray-900">{pl.total_cartons}</strong></span>
                <span>总件数：<strong className="text-gray-900">{pl.total_qty}</strong></span>
                {pl.total_gross_weight && (
                  <span>毛重：<strong className="text-gray-900">{pl.total_gross_weight} kg</strong></span>
                )}
              </div>
            </div>
            {pl.packing_list_lines?.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {['款号', '颜色', '箱数', '总件数'].map(h => (
                        <th key={h} className={`py-2 px-4 text-gray-500 font-medium ${h === '箱数' || h === '总件数' ? 'text-right' : 'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pl.packing_list_lines.map((line: any) => (
                      <tr key={line.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-2 px-4 text-gray-700">{line.style_no || '—'}</td>
                        <td className="py-2 px-4 text-gray-700">{line.color || '—'}</td>
                        <td className="py-2 px-4 text-right text-gray-700">{line.carton_count}</td>
                        <td className="py-2 px-4 text-right font-medium text-gray-900">{line.total_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
