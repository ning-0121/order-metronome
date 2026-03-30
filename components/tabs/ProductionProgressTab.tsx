'use client';

import { useState, useEffect } from 'react';
import { getProductionReports, addProductionReport, deleteProductionReport, getProductionAnalysis } from '@/app/actions/production-progress';
import type { ProductionReport, ProductionAnalysis } from '@/app/actions/production-progress';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  isAdmin: boolean;
  canReport: boolean; // 跟单/业务可提交
}

const RISK_STYLES = {
  green: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', bar: 'bg-green-500', label: '正常' },
  yellow: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', bar: 'bg-amber-500', label: '注意' },
  red: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', bar: 'bg-red-500', label: '危险' },
};

export function ProductionProgressTab({ orderId, isAdmin, canReport }: Props) {
  const router = useRouter();
  const [reports, setReports] = useState<ProductionReport[]>([]);
  const [analysis, setAnalysis] = useState<ProductionAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 表单
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10));
  const [formQty, setFormQty] = useState(0);
  const [formDefect, setFormDefect] = useState(0);
  const [formWorkers, setFormWorkers] = useState(0);
  const [formIssues, setFormIssues] = useState('');
  const [formNotes, setFormNotes] = useState('');

  useEffect(() => {
    loadData();
  }, [orderId]);

  async function loadData() {
    setLoading(true);
    const [reportsRes, analysisRes] = await Promise.all([
      getProductionReports(orderId),
      getProductionAnalysis(orderId),
    ]);
    if (reportsRes.data) setReports(reportsRes.data);
    if (analysisRes.data) setAnalysis(analysisRes.data);
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formQty <= 0) { alert('请填写当日产量'); return; }
    setSubmitting(true);

    const result = await addProductionReport(orderId, {
      report_date: formDate,
      qty_produced: formQty,
      qty_defect: formDefect,
      workers_count: formWorkers || undefined,
      issues: formIssues || undefined,
      notes: formNotes || undefined,
    });

    if (result.error) {
      alert(result.error);
    } else {
      setShowForm(false);
      setFormQty(0);
      setFormDefect(0);
      setFormWorkers(0);
      setFormIssues('');
      setFormNotes('');
      loadData();
      router.refresh();
    }
    setSubmitting(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除这条日报？')) return;
    await deleteProductionReport(id, orderId);
    loadData();
  }

  if (loading) {
    return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;
  }

  const risk = analysis ? RISK_STYLES[analysis.riskLevel] : null;

  return (
    <div className="space-y-5">
      {/* ── AI 分析概览 ── */}
      {analysis && (
        <div className={`rounded-xl p-5 border ${risk?.bg} ${risk?.border}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${risk?.bg} ${risk?.text} border ${risk?.border}`}>
                {analysis.riskLabel}
              </span>
              <span className="text-sm font-semibold text-gray-800">生产进度分析</span>
            </div>
            <span className="text-2xl font-bold text-gray-800">{analysis.progressRate}%</span>
          </div>

          {/* 进度条 */}
          <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden mb-3">
            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${risk?.bar}`} style={{ width: `${Math.min(100, analysis.progressRate)}%` }} />
            {/* 时间进度标记线 */}
            <div className="absolute top-0 h-full w-0.5 bg-gray-600" style={{ left: `${Math.min(100, analysis.timeProgressRate)}%` }} title={`时间进度 ${analysis.timeProgressRate}%`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div className="text-center">
              <div className="text-lg font-bold text-gray-800">{analysis.completedQty}</div>
              <div className="text-xs text-gray-500">已完成 / {analysis.totalQty}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-800">{analysis.dailyAvgOutput}</div>
              <div className="text-xs text-gray-500">日均产量</div>
            </div>
            <div className="text-center">
              <div className={`text-lg font-bold ${analysis.requiredDailyOutput > analysis.dailyAvgOutput * 1.2 ? 'text-red-600' : 'text-gray-800'}`}>
                {analysis.requiredDailyOutput}
              </div>
              <div className="text-xs text-gray-500">需日均产量</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-800">{analysis.daysRemaining}</div>
              <div className="text-xs text-gray-500">剩余天数</div>
            </div>
          </div>

          <p className={`text-sm ${risk?.text} leading-relaxed`}>{analysis.suggestion}</p>
        </div>
      )}

      {/* ── 新增日报按钮/表单 ── */}
      {canReport && !showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full py-3 rounded-xl border-2 border-dashed border-indigo-300 text-sm text-indigo-600 hover:bg-indigo-50 font-medium transition-colors"
        >
          + 提交生产日报
        </button>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-5 space-y-3">
          <p className="text-sm font-semibold text-gray-800">提交生产日报</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-gray-500">日期</label>
              <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">当日产量（件）<span className="text-red-500">*</span></label>
              <input type="number" min="0" value={formQty || ''} onChange={e => setFormQty(Number(e.target.value))}
                className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="0" />
            </div>
            <div>
              <label className="text-xs text-gray-500">不良数</label>
              <input type="number" min="0" value={formDefect || ''} onChange={e => setFormDefect(Number(e.target.value))}
                className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="0" />
            </div>
            <div>
              <label className="text-xs text-gray-500">工人数</label>
              <input type="number" min="0" value={formWorkers || ''} onChange={e => setFormWorkers(Number(e.target.value))}
                className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="0" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500">问题/异常（选填）</label>
            <input type="text" value={formIssues} onChange={e => setFormIssues(e.target.value)}
              className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="如有品质问题或延误请说明" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
            <button type="submit" disabled={submitting || formQty <= 0}
              className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
              {submitting ? '提交中...' : '提交日报'}
            </button>
          </div>
        </form>
      )}

      {/* ── 日报列表 ── */}
      {reports.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">暂无生产日报，跟单请定期更新进度</p>
      ) : (
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-2.5 font-medium text-gray-600">日期</th>
                <th className="px-4 py-2.5 font-medium text-gray-600 text-center">当日产量</th>
                <th className="px-4 py-2.5 font-medium text-gray-600 text-center">累计</th>
                <th className="px-4 py-2.5 font-medium text-gray-600 text-center">不良</th>
                <th className="px-4 py-2.5 font-medium text-gray-600 text-center">不良率</th>
                <th className="px-4 py-2.5 font-medium text-gray-600 text-center">工人</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">问题/备注</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">提交人</th>
                {isAdmin && <th className="px-4 py-2.5"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {reports.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-900 font-medium">{r.report_date}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-indigo-600">{r.qty_produced}</td>
                  <td className="px-4 py-2.5 text-center text-gray-700">{r.qty_cumulative}</td>
                  <td className="px-4 py-2.5 text-center text-red-500">{r.qty_defect || 0}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={r.defect_rate > 5 ? 'text-red-600 font-medium' : 'text-gray-500'}>{r.defect_rate}%</span>
                  </td>
                  <td className="px-4 py-2.5 text-center text-gray-500">{r.workers_count || '-'}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[200px] truncate">{r.issues || r.notes || '-'}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{r.reporter_name}</td>
                  {isAdmin && (
                    <td className="px-4 py-2.5">
                      <button onClick={() => handleDelete(r.id)} className="text-xs text-gray-300 hover:text-red-500">删除</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
