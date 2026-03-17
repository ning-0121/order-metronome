'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function OutsourceTab({ orderId, isAdmin }: { orderId: string; isAdmin: boolean }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    createClient().from('outsource_jobs').select('*')
      .eq('order_id', orderId).order('created_at', { ascending: false })
      .then(({ data }) => { setJobs(data || []); setLoading(false); });
  }, [orderId]);

  const statusLabels: Record<string, { label: string; cls: string }> = {
    pending: { label: '待发出', cls: 'bg-gray-100 text-gray-600' },
    in_progress: { label: '进行中', cls: 'bg-blue-100 text-blue-700' },
    returned: { label: '已回收', cls: 'bg-green-100 text-green-700' },
    closed: { label: '已关闭', cls: 'bg-gray-100 text-gray-500' },
    exception: { label: '异常', cls: 'bg-red-100 text-red-700' },
  };
  const jobTypeLabels: Record<string, string> = {
    sewing: '车缝', embroidery: '绣花', printing: '印花', washing: '洗水', other: '其他',
  };

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!jobs.length) return <div className="text-center py-12 text-gray-400">暂无外发任务</div>;

  return (
    <div className="space-y-4">
      {jobs.map(job => {
        const st = statusLabels[job.status] || { label: job.status, cls: 'bg-gray-100 text-gray-600' };
        const wip = job.qty_sent - (job.qty_pass || 0) - (job.qty_defect || 0) - (job.qty_returned || 0) - (job.qty_scrap || 0);
        return (
          <div key={job.id} className="border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-medium text-gray-900">{job.factory_name}</span>
                <span className="ml-2 text-sm text-gray-500">{jobTypeLabels[job.job_type] || job.job_type}</span>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
            </div>
            <div className="grid grid-cols-5 gap-3">
              {[
                { label: '发出', value: job.qty_sent, color: 'text-gray-700' },
                { label: '合格', value: job.qty_pass || 0, color: 'text-green-600' },
                { label: '次品', value: job.qty_defect || 0, color: 'text-red-600' },
                { label: '回收', value: job.qty_returned || 0, color: 'text-blue-600' },
                { label: '在制WIP', value: wip, color: wip > 0 ? 'text-orange-600' : 'text-gray-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center p-2 bg-gray-50 rounded-lg">
                  <div className={`text-xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            {job.notes && <p className="mt-3 text-sm text-gray-500">{job.notes}</p>}
          </div>
        );
      })}
    </div>
  );
}
