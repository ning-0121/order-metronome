import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function ExceptionsPage() {
  // V1 收敛：异常中心暂时隐藏，管理员使用 /admin「问题中心」Tab
  redirect('/admin');

  // ── 以下代码保留但不再可达 ──
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: exceptions } = await (supabase as any)
    .from('exceptions')
    .select('*, orders(order_no, customer_name)')
    .order('created_at', { ascending: false });

  const severityConfig: Record<string, { label: string; cls: string }> = {
    critical: { label: '紧急', cls: 'bg-red-600 text-white' },
    high: { label: '高', cls: 'bg-red-100 text-red-700' },
    medium: { label: '中', cls: 'bg-yellow-100 text-yellow-700' },
    low: { label: '低', cls: 'bg-gray-100 text-gray-600' },
  };
  const statusConfig: Record<string, { label: string; cardCls: string }> = {
    open: { label: '待处理', cardCls: 'bg-red-50 border-red-200' },
    in_progress: { label: '处理中', cardCls: 'bg-yellow-50 border-yellow-200' },
    resolved: { label: '已解决', cardCls: 'bg-green-50 border-green-200' },
    closed: { label: '已关闭', cardCls: 'bg-gray-50 border-gray-200' },
    escalated: { label: '已升级', cardCls: 'bg-purple-50 border-purple-200' },
  };
  const typeLabels: Record<string, string> = {
    quality: 'QC质量', material_delay: '物料延迟', production_delay: '生产延期',
    shipment: '出货异常', customer_change: '客户改单', qty_variance: '数量差异',
    cost_overrun: '成本超支', supplier: '供应商', other: '其他',
  };

  const exc = (exceptions || []) as any[];
  const openCount = exc.filter(e => e.status === 'open').length;
  const criticalCount = exc.filter(e => e.severity === 'critical').length;

  const summaryStats = [
    { label: '待处理', value: exc.filter(e => e.status === 'open').length, color: 'text-red-600' },
    { label: '处理中', value: exc.filter(e => e.status === 'in_progress').length, color: 'text-yellow-600' },
    { label: '已解决', value: exc.filter(e => e.status === 'resolved').length, color: 'text-green-600' },
    { label: '全部', value: exc.length, color: 'text-gray-700' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">异常中心</h1>
          <p className="text-sm mt-1">
            {openCount > 0 && <span className="text-red-600 font-medium mr-2">{openCount} 个待处理</span>}
            {criticalCount > 0 && <span className="text-red-500">其中 {criticalCount} 个紧急</span>}
            {openCount === 0 && <span className="text-gray-400">暂无待处理异常</span>}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* 统计 */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {summaryStats.map(({ label, value, color }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className={`text-2xl font-bold ${color}`}>{value}</div>
              <div className="text-sm text-gray-400 mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* 异常列表 */}
        <div className="space-y-3">
          {!exc.length ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
              暂无异常记录
            </div>
          ) : (
            exc.map((e: any) => {
              const sc = statusConfig[e.status] || { label: e.status, cardCls: 'bg-gray-50 border-gray-200' };
              const sv = severityConfig[e.severity] || { label: e.severity, cls: 'bg-gray-100 text-gray-600' };
              return (
                <div key={e.id} className={`rounded-xl border p-5 ${sc.cardCls}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${sv.cls}`}>{sv.label}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600">
                          {typeLabels[e.exception_type] || e.exception_type}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-500">
                          {sc.label}
                        </span>
                        {e.auto_generated && (
                          <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">自动生成</span>
                        )}
                        <Link href={`/orders/${e.order_id}`} className="text-xs text-indigo-600 hover:underline">
                          {e.orders?.order_no}
                        </Link>
                        <span className="text-xs text-gray-400">{e.orders?.customer_name}</span>
                      </div>
                      <p className="font-medium text-gray-900">{e.title}</p>
                      {e.description && <p className="text-sm text-gray-600 mt-1">{e.description}</p>}
                      {e.resolution && (
                        <div className="mt-2 p-3 bg-white rounded-lg border border-gray-200">
                          <p className="text-xs text-gray-400 mb-1">解决方案：</p>
                          <p className="text-sm text-gray-700">{e.resolution}</p>
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div className="text-xs text-gray-400">
                        {new Date(e.created_at).toLocaleDateString('zh-CN')}
                      </div>
                      {e.due_date && (
                        <div className={`text-xs mt-1 ${new Date(e.due_date) < new Date() ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                          截止：{e.due_date}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
