'use client';

import { useState, useEffect, useRef } from 'react';
import {
  getProductionReports,
  addProductionReport,
  deleteProductionReport,
  getProductionAnalysis,
  uploadProductionReportFile,
  getProductionReportAttachments,
  deleteProductionReportFile,
  extractTextFromAttachment,
} from '@/app/actions/production-progress';
import type {
  ProductionReport,
  ProductionAnalysis,
  ProductionReportAttachment,
} from '@/app/actions/production-progress';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  isAdmin: boolean;
  canReport: boolean;
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
  const [attachments, setAttachments] = useState<ProductionReportAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  // 表单
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10));
  const [formQty, setFormQty] = useState(0);
  const [formDefect, setFormDefect] = useState(0);
  const [formWorkers, setFormWorkers] = useState(0);
  const [formIssues, setFormIssues] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formFiles, setFormFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadData();
  }, [orderId]);

  async function loadData() {
    setLoading(true);
    const [reportsRes, analysisRes, attRes] = await Promise.all([
      getProductionReports(orderId),
      getProductionAnalysis(orderId),
      getProductionReportAttachments(orderId),
    ]);
    if (reportsRes.data) setReports(reportsRes.data);
    if (analysisRes.data) setAnalysis(analysisRes.data);
    if (attRes.data) setAttachments(attRes.data);
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 允许 qty=0 时必须有附件，否则没意义
    if (formQty <= 0 && formFiles.length === 0) {
      alert('请填写当日产量或至少上传一份资料');
      return;
    }
    setSubmitting(true);

    const result = await addProductionReport(orderId, {
      report_date: formDate,
      qty_produced: formQty,
      qty_defect: formDefect,
      workers_count: formWorkers || undefined,
      issues: formIssues || undefined,
      notes: formNotes || undefined,
    });

    if (result.error || !result.reportId) {
      alert(result.error || '提交失败');
      setSubmitting(false);
      return;
    }

    // 上传附件
    const uploadErrors: string[] = [];
    for (const file of formFiles) {
      const up = await uploadProductionReportFile(orderId, result.reportId, file);
      if (up.error) uploadErrors.push(`${file.name}: ${up.error}`);
    }
    if (uploadErrors.length > 0) {
      alert('部分文件上传失败：\n' + uploadErrors.join('\n'));
    }

    setShowForm(false);
    setFormQty(0);
    setFormDefect(0);
    setFormWorkers(0);
    setFormIssues('');
    setFormNotes('');
    setFormFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    loadData();
    router.refresh();
    setSubmitting(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除这条日报？关联的所有上传资料会一并删除。')) return;
    await deleteProductionReport(id, orderId);
    loadData();
  }

  async function handleDeleteFile(attId: string) {
    if (!confirm('删除这份资料？')) return;
    const r = await deleteProductionReportFile(attId, orderId);
    if (r.error) alert(r.error);
    loadData();
  }

  async function handleExtract(attId: string) {
    setExtractingId(attId);
    const r = await extractTextFromAttachment(attId);
    if (r.error) alert(r.error);
    else alert('✅ AI 识别完成');
    loadData();
    setExtractingId(null);
  }

  function handleFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setFormFiles(prev => [...prev, ...files]);
  }
  function removeFormFile(idx: number) {
    setFormFiles(prev => prev.filter((_, i) => i !== idx));
  }

  if (loading) {
    return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;
  }

  const risk = analysis ? RISK_STYLES[analysis.riskLevel] : null;
  const today = new Date().toISOString().slice(0, 10);
  const hasReportToday = reports.some(r => r.report_date === today);

  // 按 report_id 分组附件
  const attByReport = new Map<string, ProductionReportAttachment[]>();
  for (const a of attachments) {
    const list = attByReport.get(a.production_report_id) || [];
    list.push(a);
    attByReport.set(a.production_report_id, list);
  }

  return (
    <div className="space-y-5">
      {/* 今日日报提醒 */}
      {canReport && !hasReportToday && reports.length > 0 && (
        <div className="rounded-xl p-4 bg-amber-50 border border-amber-200 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-900">⏰ 今日尚未提交生产日报</p>
            <p className="text-xs text-amber-700 mt-0.5">请在每日下班前更新生产进度，保持数据实时性</p>
          </div>
          <button onClick={() => setShowForm(true)}
            className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 shrink-0">
            立即填报
          </button>
        </div>
      )}

      {/* AI 分析概览 */}
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

          <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden mb-3">
            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${risk?.bar}`} style={{ width: `${Math.min(100, analysis.progressRate)}%` }} />
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

      {/* 新增日报按钮/表单 */}
      {canReport && !showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full py-3 rounded-xl border-2 border-dashed border-indigo-300 text-sm text-indigo-600 hover:bg-indigo-50 font-medium transition-colors"
        >
          + 提交生产日报 / 上传资料
        </button>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-5 space-y-4">
          <p className="text-sm font-semibold text-gray-800">提交生产日报</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-gray-500">日期</label>
              <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">当日产量（件）</label>
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
          <div>
            <label className="text-xs text-gray-500">备注（选填）</label>
            <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={2}
              className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="今日备注、跟单观察等" />
          </div>

          {/* 文件/图片上传区 */}
          <div>
            <label className="text-xs text-gray-500">上传资料 / 图片 / 手写稿（可多选）</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
                onChange={handleFilesPicked}
                className="hidden"
                id="prod-report-files"
              />
              <label
                htmlFor="prod-report-files"
                className="px-3 py-1.5 border border-indigo-300 rounded-lg text-xs text-indigo-600 hover:bg-indigo-100 cursor-pointer"
              >
                📎 选择文件
              </label>
              <span className="text-xs text-gray-400">支持图片/PDF/Word/Excel — 图片可 AI 识别手写稿</span>
            </div>
            {formFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {formFiles.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-gray-700 bg-white px-3 py-1.5 rounded border border-gray-200">
                    <span className="flex-1 truncate">{f.name} <span className="text-gray-400">({(f.size / 1024).toFixed(0)}KB)</span></span>
                    <button type="button" onClick={() => removeFormFile(i)} className="text-red-500 hover:text-red-700">移除</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex gap-2 justify-end pt-2 border-t border-indigo-100">
            <button type="button" onClick={() => { setShowForm(false); setFormFiles([]); }} className="px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
            <button type="submit" disabled={submitting || (formQty <= 0 && formFiles.length === 0)}
              className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
              {submitting ? '提交中...' : '提交日报'}
            </button>
          </div>
        </form>
      )}

      {/* 日报列表 */}
      {reports.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">暂无生产日报，跟单请定期更新进度</p>
      ) : (
        <div className="space-y-3">
          {reports.map(r => {
            const atts = attByReport.get(r.id) || [];
            const isExpanded = expandedReportId === r.id;
            return (
              <div key={r.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50">
                  <button
                    onClick={() => setExpandedReportId(isExpanded ? null : r.id)}
                    className="text-gray-400 hover:text-gray-600 text-xs"
                    title={isExpanded ? '收起' : '展开'}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </button>
                  <span className="text-sm font-medium text-gray-900 w-24">{r.report_date}</span>
                  <span className="text-sm">
                    产量 <span className="font-semibold text-indigo-600">{r.qty_produced}</span>
                  </span>
                  <span className="text-xs text-gray-500">累计 {r.qty_cumulative}</span>
                  {r.qty_defect > 0 && (
                    <span className="text-xs text-red-500">不良 {r.qty_defect}（{r.defect_rate}%）</span>
                  )}
                  {r.workers_count && <span className="text-xs text-gray-500">工人 {r.workers_count}</span>}
                  {atts.length > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200">
                      📎 {atts.length} 份资料
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-xs text-gray-400">{r.reporter_name}</span>
                  {isAdmin && (
                    <button onClick={() => handleDelete(r.id)} className="text-xs text-gray-300 hover:text-red-500">删除</button>
                  )}
                </div>

                {/* 展开区：问题/备注 + 附件 */}
                {isExpanded && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-3">
                    {(r.issues || r.notes) && (
                      <div className="text-xs text-gray-600 space-y-1">
                        {r.issues && <div>⚠️ <span className="font-medium">问题：</span>{r.issues}</div>}
                        {r.notes && <div>📝 <span className="font-medium">备注：</span>{r.notes}</div>}
                      </div>
                    )}
                    {atts.length === 0 ? (
                      <p className="text-xs text-gray-400">无上传资料</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {atts.map(a => {
                          const isImage = (a.mime_type || '').startsWith('image/');
                          return (
                            <div key={a.id} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                              {isImage ? (
                                <a href={a.file_url} target="_blank" rel="noopener noreferrer">
                                  <img src={a.file_url} alt={a.file_name} className="w-full h-32 object-cover" />
                                </a>
                              ) : (
                                <a href={a.file_url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center justify-center h-32 bg-gray-50 text-gray-400 text-sm hover:bg-gray-100">
                                  📄 {a.file_name}
                                </a>
                              )}
                              <div className="px-2 py-1.5 text-xs">
                                <div className="truncate text-gray-700" title={a.file_name}>{a.file_name}</div>
                                <div className="text-[10px] text-gray-400 flex items-center justify-between mt-0.5">
                                  <span>{a.uploader_name} · {new Date(a.created_at).toLocaleDateString('zh-CN')}</span>
                                  <button
                                    onClick={() => handleDeleteFile(a.id)}
                                    className="text-gray-300 hover:text-red-500"
                                    title="删除"
                                  >
                                    ✕
                                  </button>
                                </div>
                                {isImage && (
                                  <div className="mt-2 pt-2 border-t border-gray-100">
                                    {a.extracted_text ? (
                                      <details className="text-[10px]">
                                        <summary className="cursor-pointer text-green-600 font-medium">
                                          ✅ AI 已识别（点击查看）
                                        </summary>
                                        <pre className="mt-1 whitespace-pre-wrap text-gray-600 font-sans leading-relaxed max-h-40 overflow-auto bg-green-50 p-2 rounded">
                                          {a.extracted_text}
                                        </pre>
                                      </details>
                                    ) : (
                                      <button
                                        onClick={() => handleExtract(a.id)}
                                        disabled={extractingId === a.id}
                                        className="text-[10px] px-2 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200 hover:bg-purple-100 disabled:opacity-50"
                                      >
                                        {extractingId === a.id ? '🤖 识别中...' : '🤖 AI 识别手写稿'}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
