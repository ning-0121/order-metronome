'use client';

import { useState } from 'react';
import { runRiskAssessment, runMissingInfoCheck, createMissingInfoTasks } from '@/app/actions/skills';
import type { SkillResult, SkillFinding, SkillSuggestion } from '@/lib/agent/skills/types';

interface Props {
  orderId: string;
  isAdmin?: boolean;
}

const SEV_COLOR: Record<string, string> = {
  high: 'bg-red-50 border-red-200 text-red-800',
  medium: 'bg-amber-50 border-amber-200 text-amber-800',
  low: 'bg-gray-50 border-gray-200 text-gray-700',
};

const SEV_LABEL: Record<string, string> = {
  high: '🔴 严重',
  medium: '🟡 注意',
  low: '⚪ 轻微',
};

const WHO_LABEL: Record<string, string> = {
  sales: '业务',
  merchandiser: '跟单',
  finance: '财务',
  procurement: '采购',
  admin: '管理员',
};

// ─── 风险评估卡 ──────────────────────────────────────────────

export function AISkillSidebar({ orderId }: Props) {
  const [result, setResult] = useState<SkillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [cached, setCached] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [ran, setRan] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await runRiskAssessment(orderId);
    setLoading(false);
    setRan(true);
    if (res.error) {
      if (res.error === '无权访问此订单的 AI Skill') return;
      setError(res.error);
    } else {
      setResult(res.result || null);
      setShadow(!!res.shadow);
      setCached(!!res.cached);
    }
  }

  // No-permission: hide entirely after first run
  if (ran && !result && !error && !shadow) return null;

  return (
    <div className="space-y-3">
      {/* ── 风险评估 ── */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-indigo-50/50 to-transparent">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>📊</span>
              <h3 className="text-sm font-semibold text-gray-900">风险评估</h3>
              {shadow && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">SHADOW</span>
              )}
              {cached && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">缓存</span>
              )}
            </div>
            {ran && (
              <button onClick={run} disabled={loading}
                className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50" title="重新计算">
                ↻
              </button>
            )}
          </div>
        </div>

        <div className="p-4">
          {!ran && !loading && (
            <button onClick={run}
              className="w-full text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium py-2 px-3 rounded-lg transition-colors">
              点击运行风险评估
            </button>
          )}
          {loading && <p className="text-xs text-gray-400">分析中...</p>}
          {ran && !loading && error && <p className="text-xs text-amber-600">⚠️ {error}</p>}
          {ran && !loading && shadow && !result && (
            <p className="text-xs text-purple-600">🔬 Shadow 模式 — 后台已运行，结果暂不展示</p>
          )}
          {ran && !loading && !error && result && (
            <>
              <p className={`text-sm font-medium mb-2 ${
                result.severity === 'high' ? 'text-red-700' :
                result.severity === 'medium' ? 'text-amber-700' : 'text-green-700'
              }`}>{result.summary}</p>
              {result.findings.length > 0 && (
                <>
                  <ul className="space-y-1.5 mt-2">
                    {(expanded ? result.findings : result.findings.slice(0, 3)).map((f, i) => (
                      <FindingItem key={i} finding={f} />
                    ))}
                  </ul>
                  {result.findings.length > 3 && (
                    <button onClick={() => setExpanded(!expanded)}
                      className="mt-2 text-xs text-indigo-500 hover:text-indigo-700">
                      {expanded ? '收起' : `查看全部 ${result.findings.length} 项 →`}
                    </button>
                  )}
                </>
              )}
              <div className="mt-3 text-[10px] text-gray-400">
                来源: {result.source} · 置信度: {result.confidence}%
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 缺失资料检查 ── */}
      <MissingInfoCard orderId={orderId} />
    </div>
  );
}

// ─── 缺失资料检查卡 ──────────────────────────────────────────

function MissingInfoCard({ orderId }: { orderId: string }) {
  const [result, setResult] = useState<SkillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [cached, setCached] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [ran, setRan] = useState(false);
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskMsg, setTaskMsg] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setTaskMsg(null);
    const res = await runMissingInfoCheck(orderId);
    setLoading(false);
    setRan(true);
    if (res.error) {
      if (res.error === '无权访问此订单的 AI Skill') return;
      setError(res.error);
    } else {
      setResult(res.result || null);
      setShadow(!!res.shadow);
      setCached(!!res.cached);
    }
  }

  async function handleCreateTasks() {
    if (!result || result.findings.length === 0) return;
    setTaskCreating(true);
    setTaskMsg(null);
    const res = await createMissingInfoTasks(orderId, result.findings);
    setTaskCreating(false);
    if (res.error) {
      setTaskMsg(`❌ ${res.error}`);
    } else if (res.created === 0) {
      setTaskMsg(`✓ 任务已存在（${res.skipped} 条已去重）`);
    } else {
      setTaskMsg(`✓ 已生成 ${res.created} 条任务${res.skipped > 0 ? `，${res.skipped} 条已存在` : ''}`);
    }
  }

  if (ran && !result && !error && !shadow) return null;

  const highCount = result?.findings.filter(f => f.severity === 'high').length ?? 0;
  const medCount  = result?.findings.filter(f => f.severity === 'medium').length ?? 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-orange-50/50 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>📋</span>
            <h3 className="text-sm font-semibold text-gray-900">缺失资料检查</h3>
            {shadow && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">SHADOW</span>
            )}
            {cached && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">缓存</span>
            )}
            {result && result.findings.length === 0 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">✓ 齐全</span>
            )}
          </div>
          {ran && (
            <button onClick={run} disabled={loading}
              className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50" title="重新检查">
              ↻
            </button>
          )}
        </div>
      </div>

      <div className="p-4">
        {!ran && !loading && (
          <button onClick={run}
            className="w-full text-xs bg-orange-50 hover:bg-orange-100 text-orange-700 font-medium py-2 px-3 rounded-lg transition-colors">
            点击检查缺失资料
          </button>
        )}

        {loading && <p className="text-xs text-gray-400">检查中...</p>}

        {ran && !loading && error && (
          <p className="text-xs text-amber-600">⚠️ {error}</p>
        )}

        {ran && !loading && shadow && !result && (
          <p className="text-xs text-purple-600">🔬 Shadow 模式 — 后台已运行，结果暂不展示</p>
        )}

        {ran && !loading && !error && result && (
          <>
            {/* 摘要行 */}
            <div className="flex items-center gap-2 mb-3">
              <p className={`text-sm font-medium flex-1 ${
                result.severity === 'high' ? 'text-red-700' :
                result.severity === 'medium' ? 'text-amber-700' : 'text-green-700'
              }`}>{result.summary}</p>
              {(highCount > 0 || medCount > 0) && (
                <div className="flex gap-1 flex-shrink-0">
                  {highCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                      {highCount} 严重
                    </span>
                  )}
                  {medCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">
                      {medCount} 注意
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* 缺失项列表 */}
            {result.findings.length > 0 && (
              <>
                <ul className="space-y-1.5">
                  {(expanded ? result.findings : result.findings.slice(0, 4)).map((f, i) => (
                    <MissingFindingItem key={i} finding={f} />
                  ))}
                </ul>
                {result.findings.length > 4 && (
                  <button onClick={() => setExpanded(!expanded)}
                    className="mt-2 text-xs text-indigo-500 hover:text-indigo-700">
                    {expanded ? '收起' : `查看全部 ${result.findings.length} 项缺失 →`}
                  </button>
                )}
              </>
            )}

            {/* 建议动作 */}
            {result.suggestions.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <p className="text-[10px] font-semibold text-gray-500 mb-1.5">建议动作</p>
                <ul className="space-y-1">
                  {result.suggestions.slice(0, 3).map((s, i) => (
                    <SuggestionItem key={i} suggestion={s} />
                  ))}
                </ul>
              </div>
            )}

            {/* 生成处理任务 */}
            {result.findings.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <button
                  onClick={handleCreateTasks}
                  disabled={taskCreating}
                  className="w-full text-xs bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white font-medium py-2 px-3 rounded-lg transition-colors"
                >
                  {taskCreating ? '生成中…' : '生成处理任务'}
                </button>
                {taskMsg && (
                  <p className={`mt-1.5 text-[11px] text-center ${
                    taskMsg.startsWith('❌') ? 'text-red-600' : 'text-green-700'
                  }`}>{taskMsg}</p>
                )}
              </div>
            )}

            <div className="mt-3 text-[10px] text-gray-400">
              来源: {result.source} · 置信度: {result.confidence}%
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 子组件 ──────────────────────────────────────────────────

function FindingItem({ finding }: { finding: SkillFinding }) {
  const isDataStatus = finding.category === '数据状态';
  const className = isDataStatus ? 'bg-blue-50 border-blue-200 text-blue-800' : SEV_COLOR[finding.severity];
  const icon = isDataStatus ? 'ℹ️ 数据' : SEV_LABEL[finding.severity];

  return (
    <li className={`text-xs px-2 py-1.5 rounded border ${className}`}>
      <div className="flex items-start gap-1.5">
        <span className="shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="font-medium">{finding.label}</p>
          {finding.detail && <p className="text-[11px] mt-0.5 opacity-90">{finding.detail}</p>}
          {finding.evidence ? (
            <p className="text-[10px] mt-1 text-gray-500 italic break-all">📎 依据：{finding.evidence}</p>
          ) : (
            !isDataStatus && (
              <p className="text-[10px] mt-1 text-amber-600 italic">⚠ 此条无明确数据依据 — 仅供参考</p>
            )
          )}
          {finding.blocksStepName && (
            <p className="text-[10px] mt-0.5 opacity-75">
              卡 {finding.blocksStepName}
              {finding.daysToBlocker !== undefined && finding.daysToBlocker >= 0 && (
                <span className="font-bold"> · 剩 {finding.daysToBlocker} 天</span>
              )}
              {finding.whoShouldFix && <span> · 责任：{finding.whoShouldFix}</span>}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function MissingFindingItem({ finding }: { finding: SkillFinding }) {
  const sev = finding.severity;
  const borderCls =
    sev === 'high' ? 'border-red-200 bg-red-50' :
    sev === 'medium' ? 'border-amber-200 bg-amber-50' :
    'border-gray-200 bg-gray-50';
  const dot =
    sev === 'high' ? 'bg-red-500' :
    sev === 'medium' ? 'bg-amber-400' : 'bg-gray-300';

  return (
    <li className={`text-xs px-2.5 py-2 rounded-lg border ${borderCls}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-medium text-gray-800">{finding.label}</p>
            {finding.whoShouldFix && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-white border border-gray-200 text-gray-500">
                {WHO_LABEL[finding.whoShouldFix] ?? finding.whoShouldFix}
              </span>
            )}
          </div>
          {finding.blocksStepName && (
            <p className="text-[10px] mt-0.5 text-gray-500">
              卡：{finding.blocksStepName}
              {finding.daysToBlocker !== undefined && finding.daysToBlocker >= 0 && (
                <span className={`ml-1 font-semibold ${sev === 'high' ? 'text-red-600' : 'text-amber-600'}`}>
                  · 剩 {finding.daysToBlocker} 天
                </span>
              )}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function SuggestionItem({ suggestion }: { suggestion: SkillSuggestion }) {
  return (
    <li className="flex items-start gap-1.5 text-[11px] text-gray-600">
      <span className="text-indigo-400 flex-shrink-0 mt-0.5">→</span>
      <span>
        {suggestion.action}
        {suggestion.targetRole && (
          <span className="ml-1 text-[10px] text-gray-400">（{suggestion.targetRole}）</span>
        )}
      </span>
    </li>
  );
}
