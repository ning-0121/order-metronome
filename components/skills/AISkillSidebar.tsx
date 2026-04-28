'use client';

import { useState } from 'react';
import { runRiskAssessment } from '@/app/actions/skills';
import type { SkillResult, SkillFinding } from '@/lib/agent/skills/types';

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
      if (res.error === '无权访问此订单的 AI Skill') return; // silently hide
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
            <button
              onClick={run}
              disabled={loading}
              className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
              title="重新计算"
            >
              ↻
            </button>
          )}
        </div>
      </div>

      <div className="p-4">
        {!ran && !loading && (
          <button
            onClick={run}
            className="w-full text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium py-2 px-3 rounded-lg transition-colors"
          >
            点击运行风险评估
          </button>
        )}

        {loading && <p className="text-xs text-gray-400">分析中...</p>}

        {ran && !loading && error && (
          <p className="text-xs text-amber-600">⚠️ {error}</p>
        )}

        {ran && !loading && shadow && !result && (
          <p className="text-xs text-purple-600">🔬 Shadow 模式 — 后台已运行，结果暂不展示</p>
        )}

        {ran && !loading && !error && result && (
          <>
            <p className={`text-sm font-medium mb-2 ${
              result.severity === 'high' ? 'text-red-700' :
              result.severity === 'medium' ? 'text-amber-700' :
              'text-green-700'
            }`}>
              {result.summary}
            </p>

            {result.findings.length > 0 && (
              <>
                <ul className="space-y-1.5 mt-2">
                  {(expanded ? result.findings : result.findings.slice(0, 3)).map((f, i) => (
                    <FindingItem key={i} finding={f} />
                  ))}
                </ul>
                {result.findings.length > 3 && (
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="mt-2 text-xs text-indigo-500 hover:text-indigo-700"
                  >
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
  );
}

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
