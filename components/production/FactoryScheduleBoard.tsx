'use client';

/**
 * 工厂排产看板(P3)—— 按工厂视角看负荷,补齐排产工作台(按订单视角)的另一面。
 * 每个工厂:近 6 月产能账(已派/产能,超卖标红)+ 名下全部在排派工(跨订单),排产冲突/大单拆多厂一眼看清。
 * 可导出该厂「派工单」Excel 下发工厂。
 */

import { useEffect, useState } from 'react';
import { getFactoryScheduleBoard, exportFactoryDispatchSheet } from '@/app/actions/production-scheduling';

const stCn: Record<string, string> = { scheduled: '已排', in_production: '生产中' };

function download(base64: string, fileName: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

export function FactoryScheduleBoard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string>('');
  const [msg, setMsg] = useState('');
  const [busyExport, setBusyExport] = useState('');

  useEffect(() => {
    getFactoryScheduleBoard().then((r) => { setData((r as any).data || { factories: [] }); setLoading(false); if ((r as any).error) setMsg((r as any).error); });
  }, []);

  async function doExport(fid: string) {
    setBusyExport(fid); setMsg('');
    const r = await exportFactoryDispatchSheet(fid);
    setBusyExport('');
    if ((r as any).error) { setMsg((r as any).error); return; }
    download((r as any).base64, (r as any).fileName);
  }

  if (loading) return <div className="text-sm text-gray-400 py-6">加载工厂负荷…</div>;
  const factories = data?.factories || [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold text-gray-800">🏭 工厂排产看板</h2>
        <span className="text-xs text-gray-500">按工厂看负荷:各月产能账 + 名下派工(跨订单),超卖标红。可导派工单。</span>
        {msg && <span className="text-xs text-rose-600">{msg}</span>}
      </div>
      {factories.length === 0 ? <p className="text-sm text-gray-400">暂无工厂。</p> : factories.map((f: any) => {
        const anyOver = (f.ledger || []).some((m: any) => m.remaining != null && m.remaining < 0);
        return (
          <div key={f.id} className={`rounded-xl border bg-white p-3 ${anyOver ? 'border-rose-200' : 'border-gray-200'}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-semibold text-gray-900">{f.factory_name}</span>
                  <span className="text-xs text-gray-500">月产能 <b className="text-gray-700">{f.monthly_capacity ?? '—'}</b></span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${f.capacity_label === '月产能未配置' ? 'bg-slate-100 text-slate-700' : f.capacity_label === '配置产能为0' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{f.capacity_label}</span>
                  <span className="text-xs text-gray-500">在排 <b className="text-gray-700">{f.active_count}</b> 单 · <b className="text-gray-700">{f.total_committed}</b> 件</span>
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{f.source_label}</span>
                  {anyOver && <span className="text-xs px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">有月份超卖</span>}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-400 flex-wrap">
                  {(f.quality_grades || []).length > 0 && <span>品质 {f.quality_grades.join('/')}</span>}
                  {(f.weave_types || []).length > 0 && <span>· {f.weave_types.join('/')}</span>}
                  {f.can_package && <span>· 可包装</span>}
                  {(f.order_capabilities || []).length > 0 && <span>· {f.order_capabilities.join('/')}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {f.dispatches.length > 0 && (
                  <button onClick={() => doExport(f.id)} disabled={busyExport === f.id} className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">{busyExport === f.id ? '导出中…' : '⬇ 派工单'}</button>
                )}
                <button onClick={() => setOpen(open === f.id ? '' : f.id)} className="text-xs text-indigo-600 hover:underline">{open === f.id ? '收起' : `明细(${f.active_count})`}</button>
              </div>
            </div>

            {/* 近 6 月产能账 */}
            <div className="mt-2 flex items-stretch gap-1.5 overflow-x-auto">
              {(f.ledger || []).map((m: any) => {
                const over = m.remaining != null && m.remaining < 0;
                const pct = m.capacity ? Math.min(100, Math.round((m.committed / m.capacity) * 100)) : 0;
                return (
                  <div key={m.month} className={`shrink-0 w-24 rounded-lg border px-2 py-1.5 ${over ? 'border-rose-200 bg-rose-50' : m.committed > 0 ? 'border-indigo-100 bg-indigo-50/50' : 'border-gray-100 bg-gray-50'}`}>
                    <div className="text-[11px] text-gray-500">{m.month.slice(5)}月</div>
                    <div className={`text-xs font-semibold ${over ? 'text-rose-600' : 'text-gray-800'}`}>{m.committed}<span className="text-gray-400 font-normal">/{m.capacity ?? '—'}</span></div>
                    {m.capacity != null && (
                      <div className="mt-1 h-1 rounded-full bg-gray-200 overflow-hidden"><div className={over ? 'h-full bg-rose-500' : 'h-full bg-indigo-500'} style={{ width: `${pct}%` }} /></div>
                    )}
                    {m.remaining != null && <div className={`text-[10px] ${over ? 'text-rose-500' : 'text-gray-400'}`}>{over ? `超${-m.remaining}` : `剩${m.remaining}`}</div>}
                  </div>
                );
              })}
            </div>

            {/* 派工明细(跨订单) */}
            {open === f.id && (
              <div className="mt-2 overflow-x-auto">
                {f.dispatches.length === 0 ? <p className="text-xs text-gray-400">该工厂暂无在排派工。</p> : (
                  <table className="text-[11px] w-full">
                    <thead><tr className="text-gray-400 text-left border-b border-gray-100">
                      {['订单', '客户', '款号', '颜色', '件数', '完成', '排产窗口', '交期', '来源', '状态'].map((h) => <th key={h} className="px-1.5 py-1 whitespace-nowrap font-medium">{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {f.dispatches.map((d: any) => (
                        <tr key={d.id} className="border-b border-gray-50">
                          <td className="px-1.5 py-1 font-mono text-gray-700 whitespace-nowrap">{d.order?.internal_order_no || d.order?.order_no || '—'}</td>
                          <td className="px-1.5 py-1 text-gray-600 whitespace-nowrap">{d.order?.customer_name || '—'}</td>
                          <td className="px-1.5 py-1 font-mono text-gray-800">{d.style_no || '(整单)'}</td>
                          <td className="px-1.5 py-1 text-gray-600">{d.color || '整款'}</td>
                          <td className="px-1.5 py-1 text-right text-gray-800">{d.planned_qty ?? '—'}</td>
                          <td className={`px-1.5 py-1 text-right font-medium ${d.planned_qty && d.done_qty >= d.planned_qty ? 'text-emerald-600' : d.done_qty > 0 ? 'text-indigo-600' : 'text-gray-400'}`}>{d.done_qty || 0}</td>
                          <td className="px-1.5 py-1 text-gray-500 whitespace-nowrap">{d.planned_start ? `${String(d.planned_start).slice(5, 10)}~${String(d.planned_end || '').slice(5, 10)}` : '—'}</td>
                          <td className="px-1.5 py-1 text-gray-500 whitespace-nowrap">{d.order?.factory_date ? String(d.order.factory_date).slice(5, 10) : '—'}</td>
                          <td className="px-1.5 py-1"><span className={`rounded-full px-1.5 py-0.5 text-[10px] ${d.source === 'legacy' ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>{d.source === 'legacy' ? 'legacy' : 'dispatch'}</span></td>
                          <td className="px-1.5 py-1"><span className={d.status === 'in_production' ? 'text-emerald-700' : 'text-gray-600'}>{stCn[d.status] || d.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
