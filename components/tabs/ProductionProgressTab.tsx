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
import { getMilestonesByOrder } from '@/app/actions/milestones';

// ── 跟单时间线定义 ──
// 评审会完成后，系统生成跟单的工厂拜访计划和关键检查节点
const MERCH_TIMELINE_STEPS: Array<{
  step_key: string;
  label: string;
  action: string;        // 跟单要做什么
  deliverable: string;   // 需要带回什么
  timing: string;        // 时间要求
  icon: string;
}> = [
  {
    step_key: 'pre_production_sample_ready',
    label: '① 封样交付',
    action: '跟进工厂出封样，检查尺寸/做工/颜色/面料，拍照记录',
    deliverable: '封样照片（正面/背面/细节/测量）',
    timing: '工厂确认后 2 天内必须交付',
    icon: '👔',
  },
  {
    step_key: 'materials_received_inspected',
    label: '② 面料到货验收',
    action: '到布后第一时间去工厂：检验品质、比对颜色、确认克重缩水率。跟单+业务双确认后才能开裁',
    deliverable: '面料检验报告 + 布样带回（如需寄客户确认）',
    timing: '面料到货当天或次日',
    icon: '🧵',
  },
  {
    step_key: 'production_kickoff',
    label: '③ 上线工艺确认',
    action: '开裁后 2 天内去工厂：确认首件裁片尺寸、车缝工艺、印花绣花、辅料。确认组长正确理解工艺、工人按要求执行、有正确样衣参照',
    deliverable: '首件确认照片 + 工艺确认表',
    timing: '开裁后 2 天内',
    icon: '✂️',
  },
  {
    step_key: 'mid_qc_check',
    label: '④ 中期验货（中查）',
    action: '生产完成 30-50% 时去工厂：抽检 5 件量尺寸，检查色差/做工/功能，记录问题要求整改',
    deliverable: '中查报告（含尺寸数据+外观照片+问题清单）',
    timing: '生产进度达 30-50%',
    icon: '🔍',
  },
  {
    step_key: 'packing_method_confirmed',
    label: '⑤ 包装确认',
    action: '去工厂核对：内包装/外箱唛头/吊牌洗标条码/装箱方式。拍照记录',
    deliverable: '包装照片（内包装+外箱+唛头）+ 装箱数据',
    timing: '尾查前完成',
    icon: '📦',
  },
  {
    step_key: 'final_qc_check',
    label: '⑥ 尾期验货（尾查）',
    action: '按 AQL 标准抽检：尺寸/做工/外观/颜色/功能逐项检查，统计严重/主要/次要缺陷数',
    deliverable: 'AQL 尾查报告（含缺陷统计+照片）',
    timing: '生产完成 80% 以上',
    icon: '✅',
  },
  {
    step_key: 'inspection_release',
    label: '⑦ 出货前验货',
    action: '最终检查：数量核对、品质复检、包装完整、唛头核对、箱单核对',
    deliverable: '出货验货报告',
    timing: '出货前 2-3 天',
    icon: '🚛',
  },
];

interface MerchMilestone {
  step_key: string;
  name: string;
  status: string;
  due_at: string | null;
  actual_at: string | null;
}

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
  const [merchMilestones, setMerchMilestones] = useState<MerchMilestone[]>([]);
  const [showTimeline, setShowTimeline] = useState(true);
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
    const [reportsRes, analysisRes, attRes, msRes] = await Promise.all([
      getProductionReports(orderId),
      getProductionAnalysis(orderId),
      getProductionReportAttachments(orderId),
      getMilestonesByOrder(orderId),
    ]);
    if (reportsRes.data) setReports(reportsRes.data);
    if (analysisRes.data) setAnalysis(analysisRes.data);
    if (attRes.data) setAttachments(attRes.data);
    if (msRes.data) {
      const stepKeys = new Set(MERCH_TIMELINE_STEPS.map(s => s.step_key));
      setMerchMilestones(
        (msRes.data as any[])
          .filter(m => stepKeys.has(m.step_key))
          .map(m => ({ step_key: m.step_key, name: m.name, status: m.status, due_at: m.due_at, actual_at: m.actual_at }))
      );
    }
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

  // 跟单时间线数据：匹配 milestones 到 timeline steps
  const timelineData = MERCH_TIMELINE_STEPS.map(step => {
    const ms = merchMilestones.find(m => m.step_key === step.step_key);
    const isDone = ms && (ms.status === 'done' || ms.status === '已完成');
    const isInProgress = ms && (ms.status === 'in_progress' || ms.status === '进行中');
    const isOverdue = ms?.due_at && !isDone && new Date(ms.due_at) < new Date();
    const dueStr = ms?.due_at ? new Date(ms.due_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—';
    return { ...step, ms, isDone, isInProgress, isOverdue, dueStr };
  });
  const completedCount = timelineData.filter(t => t.isDone).length;
  // 评审会是否完成（控制时间线是否显示）
  const kickoffDone = merchMilestones.length > 0; // 有跟单节点数据说明订单已创建

  return (
    <div className="space-y-5">
      {/* ── 跟单流程时间线 ── */}
      {kickoffDone && (
        <div className="rounded-xl border border-indigo-200 bg-white overflow-hidden">
          <button
            onClick={() => setShowTimeline(!showTimeline)}
            className="w-full flex items-center justify-between px-5 py-3 bg-indigo-50 hover:bg-indigo-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">📋</span>
              <span className="text-sm font-bold text-indigo-900">跟单流程单</span>
              <span className="text-xs text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
                {completedCount}/{timelineData.length} 完成
              </span>
            </div>
            <span className="text-indigo-400 text-sm">{showTimeline ? '收起 ▲' : '展开 ▼'}</span>
          </button>

          {showTimeline && (
            <div className="px-5 py-4">
              {/* 进度条 */}
              <div className="mb-4">
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all"
                    style={{ width: `${(completedCount / timelineData.length) * 100}%` }}
                  />
                </div>
              </div>

              {/* 时间线 */}
              <div className="relative">
                {timelineData.map((item, idx) => {
                  const statusColor = item.isDone
                    ? 'bg-green-500'
                    : item.isOverdue
                      ? 'bg-red-500'
                      : item.isInProgress
                        ? 'bg-indigo-500 animate-pulse'
                        : 'bg-gray-300';
                  const textColor = item.isDone
                    ? 'text-green-700'
                    : item.isOverdue
                      ? 'text-red-700'
                      : item.isInProgress
                        ? 'text-indigo-700'
                        : 'text-gray-500';

                  return (
                    <div key={item.step_key} className="flex gap-3 mb-0">
                      {/* 竖线 + 圆点 */}
                      <div className="flex flex-col items-center w-6 shrink-0">
                        <div className={`w-3 h-3 rounded-full ${statusColor} z-10 mt-1.5`} />
                        {idx < timelineData.length - 1 && (
                          <div className={`w-0.5 flex-1 min-h-[40px] ${item.isDone ? 'bg-green-200' : 'bg-gray-200'}`} />
                        )}
                      </div>

                      {/* 内容 */}
                      <div className={`flex-1 pb-4 ${item.isDone ? 'opacity-60' : ''}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-base">{item.icon}</span>
                          <span className={`text-sm font-semibold ${textColor}`}>
                            {item.label}
                          </span>
                          {item.isDone && (
                            <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">✓ 已完成</span>
                          )}
                          {item.isOverdue && (
                            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">⚠ 逾期</span>
                          )}
                          {item.isInProgress && (
                            <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">● 进行中</span>
                          )}
                          <span className="text-xs text-gray-400 ml-auto">
                            截止 {item.dueStr}
                          </span>
                        </div>
                        <p className="text-xs text-gray-600 mt-1 leading-relaxed">{item.action}</p>
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-indigo-500">📎</span>
                          <span className="text-xs text-indigo-600">{item.deliverable}</span>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <p className="text-xs text-amber-600">⏰ {item.timing}</p>
                          {!item.isDone && item.ms && (
                            <a
                              href={`/orders/${orderId}?tab=progress#milestone-${item.ms.step_key}`}
                              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                            >
                              去执行 →
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 额外工厂拜访建议 */}
              <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <p className="text-xs font-semibold text-amber-800 mb-1">📅 其他关键拜访时间</p>
                <ul className="text-xs text-amber-700 space-y-0.5">
                  <li>• <strong>采购下单后 3 天</strong> — 确认工厂已收到面料订单，核实交期</li>
                  <li>• <strong>面料到货前 2 天</strong> — 提前与工厂确认仓库准备，安排验布时间</li>
                  <li>• <strong>生产进度 60-70%</strong> — 补充巡检，确认中查问题已整改</li>
                  <li>• <strong>包装完成后</strong> — 抽查成品包装，确认唛头/箱单无误</li>
                  <li>• <strong>装柜/出货当天</strong> — 现场监装（如大货/重要客户），拍照留底</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 生产已启动但无日报 — 红色警告 */}
      {analysis?.productionStarted && analysis?.shouldReport && reports.length === 0 && (
        <div className="rounded-xl p-4 bg-red-50 border border-red-200 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-red-900">🚨 生产已启动 {analysis.daysSinceKickoff} 天，但未收到任何日报</p>
            <p className="text-xs text-red-700 mt-0.5">请立即联系工厂确认生产进度，剩余 {analysis.daysRemaining} 天需出厂</p>
          </div>
          {canReport && (
            <button onClick={() => setShowForm(true)}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 shrink-0">
              提交日报
            </button>
          )}
        </div>
      )}

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

          {/* 趋势指标行 */}
          {(analysis.trend !== 'unknown' || analysis.defectTrend !== 'unknown' || analysis.efficiencyPerWorker > 0) && (
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-gray-200/60">
              {analysis.trend !== 'unknown' && (
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                  analysis.trend === 'up' ? 'bg-green-100 text-green-700' :
                  analysis.trend === 'down' ? 'bg-red-100 text-red-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {analysis.trend === 'up' ? '↑' : analysis.trend === 'down' ? '↓' : '→'} {analysis.trendDetail}
                </span>
              )}
              {analysis.defectTrend === 'rising' && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">
                  ⚠ 不良率上升
                </span>
              )}
              {analysis.efficiencyPerWorker > 0 && (
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                  analysis.efficiencyPerWorker < 20 ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                }`}>
                  👤 人均 {analysis.efficiencyPerWorker} 件/天
                </span>
              )}
            </div>
          )}

          {/* 风险警告列表 */}
          {analysis.warnings && analysis.warnings.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-200/60 space-y-1">
              {analysis.warnings.map((w, i) => (
                <p key={i} className="text-xs text-red-600 flex items-start gap-1.5">
                  <span className="shrink-0">⚠</span>
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}
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
