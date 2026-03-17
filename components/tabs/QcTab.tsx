'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function QcTab({ orderId, isAdmin, currentRole }: {
  orderId: string; isAdmin: boolean; currentRole: string;
}) {
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    createClient().from('qc_inspections').select('*')
      .eq('order_id', orderId).order('inspection_date', { ascending: false })
      .then(({ data }) => { setRecords(data || []); setLoading(false); });
  }, [orderId]);

  const resultConfig: Record<string, { label: string; cls: string }> = {
    pending: { label: '待检', cls: 'bg-gray-100 text-gray-600' },
    pass: { label: '通过', cls: 'bg-green-100 text-green-700' },
    fail: { label: '不通过', cls: 'bg-red-100 text-red-700' },
    conditional: { label: '有条件通过', cls: 'bg-yellow-100 text-yellow-700' },
  };
  const typeLabels: Record<string, string> = {
    mid: '中查', final: '尾查', inline: '巡查', 're-inspection': '复检',
  };

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!records.length) return <div className="text-center py-12 text-gray-400">暂无 QC 检验记录</div>;

  return (
    <div className="space-y-4">
      {records.map(rec => {
        const rc = resultConfig[rec.result] || { label: rec.result, cls: 'bg-gray-100 text-gray-600' };
        const passRate = rec.qty_inspected > 0 ? Math.round(rec.qty_pass / rec.qty_inspected * 100) : 0;
        return (
          <div key={rec.id} className="border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="font-medium text-gray-900">{typeLabels[rec.inspection_type] || rec.inspection_type}</span>
                <span className="text-sm text-gray-400">{rec.inspection_date}</span>
                <span className="text-xs text-gray-400">AQL {rec.aql_level}</span>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${rc.cls}`}>{rc.label}</span>
            </div>
            <div className="grid grid-cols-4 gap-3 mb-3">
              {[
                { label: '抽检数', value: rec.qty_inspected, color: 'text-gray-700' },
                { label: '合格', value: rec.qty_pass, color: 'text-green-600' },
                { label: '不合格', value: rec.qty_fail, color: 'text-red-600' },
                { label: '合格率', value: passRate + '%', color: passRate >= 90 ? 'text-green-600' : passRate >= 70 ? 'text-yellow-600' : 'text-red-600' },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center p-2 bg-gray-50 rounded-lg">
                  <div className={`text-xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            {rec.notes && <p className="text-sm text-gray-500">{rec.notes}</p>}
          </div>
        );
      })}
    </div>
  );
}
