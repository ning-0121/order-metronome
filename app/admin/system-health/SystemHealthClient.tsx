'use client';

import { useState } from 'react';
import { runSystemGuardianNow } from '@/app/actions/system-health';

const CATEGORY_LABELS: Record<string, string> = {
  security: '🔐 安全性',
  stability: '⚙️ 稳定性',
  metronome: '🎯 节拍器',
  time: '⏰ 时间',
  permission: '👤 权限',
  ai_evolution: '🤖 AI 进化',
};

const SEVERITY_STYLES: Record<string, string> = {
  ok: 'bg-green-50 text-green-700 border-green-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  critical: 'bg-red-50 text-red-700 border-red-200',
};

const SEVERITY_ICONS: Record<string, string> = {
  ok: '✅',
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔴',
};

interface CheckResult {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  severity: string;
  message: string;
  details?: any;
  auto_fixed?: boolean;
  auto_fix_note?: string;
}

interface Report {
  id: string;
  ran_at: string;
  took_ms: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  critical_count: number;
  auto_fixed_count: number;
  checks: CheckResult[];
  meta_review: any;
}

export function SystemHealthClient({ initialReports }: { initialReports: Report[] }) {
  const [reports, setReports] = useState(initialReports);
  const [selectedId, setSelectedId] = useState<string | null>(initialReports[0]?.id || null);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selected = reports.find(r => r.id === selectedId);

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await runSystemGuardianNow();
      if (res.error) {
        alert(res.error);
      } else if (res.report) {
        setReports(prev => [res.report, ...prev]);
        setSelectedId(res.report.id);
        alert(`✅ 运行完成：${res.report.passed_count}/${res.report.total_checks} 通过`);
      }
    } catch (e: any) {
      alert('运行失败：' + e?.message);
    } finally {
      setRunning(false);
    }
  }

  if (reports.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400 mb-4">暂无系统守护报告</p>
        <button
          onClick={handleRunNow}
          disabled={running}
          className="px-6 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
        >
          {running ? '运行中（可能需要 30 秒）...' : '立即运行系统守护'}
        </button>
      </div>
    );
  }

  const byCategory: Record<string, CheckResult[]> = {};
  for (const c of selected?.checks || []) {
    if (!byCategory[c.category]) byCategory[c.category] = [];
    byCategory[c.category].push(c);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* 左侧：历史报告列表 */}
      <div className="lg:col-span-1">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">历史报告</h2>
          <button
            onClick={handleRunNow}
            disabled={running}
            className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {running ? '运行中...' : '立即运行'}
          </button>
        </div>
        <div className="space-y-2 max-h-[70vh] overflow-auto">
          {reports.map(r => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs border transition-all ${
                selectedId === r.id
                  ? 'bg-emerald-50 border-emerald-300'
                  : 'bg-white border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-gray-900">
                {new Date(r.ran_at).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-green-600">✅{r.passed_count}</span>
                {r.warning_count > 0 && <span className="text-amber-600">⚠{r.warning_count}</span>}
                {r.critical_count > 0 && <span className="text-red-600">🔴{r.critical_count}</span>}
                {r.auto_fixed_count > 0 && (
                  <span className="text-blue-600">🔧{r.auto_fixed_count}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：选中报告详情 */}
      <div className="lg:col-span-3">
        {selected && (
          <div className="space-y-4">
            {/* 概览 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-900">
                  {new Date(selected.ran_at).toLocaleString('zh-CN')}
                </h2>
                <span className="text-xs text-gray-400">
                  耗时 {(selected.took_ms / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div className="text-center p-3 rounded-lg bg-green-50">
                  <div className="text-2xl font-bold text-green-600">{selected.passed_count}</div>
                  <div className="text-xs text-gray-500">通过</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50">
                  <div className="text-2xl font-bold text-amber-600">{selected.warning_count}</div>
                  <div className="text-xs text-gray-500">警告</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-red-50">
                  <div className="text-2xl font-bold text-red-600">{selected.critical_count}</div>
                  <div className="text-xs text-gray-500">严重</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-blue-50">
                  <div className="text-2xl font-bold text-blue-600">{selected.auto_fixed_count}</div>
                  <div className="text-xs text-gray-500">自动修复</div>
                </div>
              </div>
            </div>

            {/* AI 元审视 */}
            {selected.meta_review && (
              <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">🤖</span>
                  <h3 className="text-sm font-semibold text-indigo-900">AI 总结</h3>
                </div>
                <p className="text-sm text-gray-800 leading-relaxed mb-3">
                  {selected.meta_review.summary}
                </p>
                {selected.meta_review.concerns?.length > 0 && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-indigo-700 mb-1">⚠ 关注点</div>
                    <ul className="text-xs text-gray-700 space-y-1">
                      {selected.meta_review.concerns.map((c: string, i: number) => (
                        <li key={i}>• {c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.meta_review.trends?.length > 0 && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-indigo-700 mb-1">📊 趋势</div>
                    <ul className="text-xs text-gray-700 space-y-1">
                      {selected.meta_review.trends.map((t: string, i: number) => (
                        <li key={i}>• {t}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.meta_review.recommended_actions?.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-indigo-700 mb-1">💡 建议</div>
                    <ul className="text-xs text-gray-700 space-y-1">
                      {selected.meta_review.recommended_actions.map((a: string, i: number) => (
                        <li key={i}>• {a}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* 按类别分组的检查结果 */}
            {Object.entries(byCategory).map(([cat, checks]) => (
              <div key={cat} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 font-medium text-sm text-gray-700">
                  {CATEGORY_LABELS[cat] || cat}
                  <span className="ml-2 text-xs text-gray-500">
                    ({checks.filter(c => c.passed).length}/{checks.length})
                  </span>
                </div>
                <div className="divide-y divide-gray-100">
                  {checks.map(c => (
                    <div key={c.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <span className="text-sm">{SEVERITY_ICONS[c.severity]}</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-900">{c.title}</span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLES[c.severity]}`}
                            >
                              {c.severity}
                            </span>
                            {c.auto_fixed && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                🔧 已修复
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-600 mt-0.5">{c.message}</p>
                          {c.auto_fix_note && (
                            <p className="text-[10px] text-blue-600 mt-0.5">
                              → {c.auto_fix_note}
                            </p>
                          )}
                          {c.details && Object.keys(c.details).length > 0 && (
                            <button
                              onClick={() =>
                                setExpanded(prev => ({ ...prev, [c.id]: !prev[c.id] }))
                              }
                              className="text-[10px] text-gray-400 hover:text-gray-600 mt-1"
                            >
                              {expanded[c.id] ? '收起详情' : '查看详情 →'}
                            </button>
                          )}
                          {expanded[c.id] && (
                            <pre className="text-[10px] bg-gray-50 rounded p-2 mt-1 overflow-auto max-h-40 text-gray-600">
                              {JSON.stringify(c.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
