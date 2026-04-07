'use client';

/**
 * AI Skills 侧边栏 — 订单详情页右上角小卡片栏
 *
 * Phase 1 只展示「缺失资料检查」一个 Skill。
 * Skill 1（风险评估）和 Skill 3（报价审核）在 shadow 模式下后台跑，UI 不展示。
 *
 * 仅 admin 可见。
 */

import { useEffect, useState } from 'react';
import { runMissingInfoCheck, runRiskAssessment } from '@/app/actions/skills';
import type { SkillResult, SkillFinding } from '@/lib/agent/skills/types';

interface Props {
  orderId: string;
  isAdmin: boolean;
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

interface SkillState {
  result: SkillResult | null;
  error: string | null;
  shadow: boolean;
  loading: boolean;
}

const INITIAL_STATE: SkillState = {
  result: null,
  error: null,
  shadow: false,
  loading: true,
};

export function AISkillSidebar({ orderId, isAdmin }: Props) {
  const [missing, setMissing] = useState<SkillState>(INITIAL_STATE);
  const [risk, setRisk] = useState<SkillState>(INITIAL_STATE);
  const [refreshKey, setRefreshKey] = useState(0);

  // Phase 1：仅 admin 可见
  useEffect(() => {
    if (!isAdmin) {
      setMissing({ ...INITIAL_STATE, loading: false });
      setRisk({ ...INITIAL_STATE, loading: false });
      return;
    }
    let cancelled = false;

    // 并行加载两个 Skill
    setMissing({ ...INITIAL_STATE, loading: true });
    setRisk({ ...INITIAL_STATE, loading: true });

    runMissingInfoCheck(orderId).then(res => {
      if (cancelled) return;
      setMissing({
        result: res.result || null,
        error: res.error || null,
        shadow: !!res.shadow,
        loading: false,
      });
    });

    runRiskAssessment(orderId).then(res => {
      if (cancelled) return;
      setRisk({
        result: res.result || null,
        error: res.error || null,
        shadow: !!res.shadow,
        loading: false,
      });
    });

    return () => { cancelled = true; };
  }, [orderId, isAdmin, refreshKey]);

  if (!isAdmin) return null;

  const refresh = () => setRefreshKey(k => k + 1);

  return (
    <div className="space-y-3">
      {/* Skill 1：风险评估 */}
      <SkillCard
        title="风险评估"
        icon="📊"
        loading={risk.loading}
        error={risk.error}
        result={risk.result}
        shadow={risk.shadow}
        onRefresh={refresh}
      />

      {/* Skill 2：缺失资料 */}
      <SkillCard
        title="缺失资料检查"
        icon="📋"
        loading={missing.loading}
        error={missing.error}
        result={missing.result}
        shadow={missing.shadow}
        onRefresh={refresh}
      />

      {/* Phase 1 占位：报价审核（下一波） */}
      <div className="text-xs text-gray-400 text-center py-2 border border-dashed border-gray-200 rounded-lg">
        💡 报价审核 Skill 即将上线
        <br />
        <span className="text-[10px]">在订单详情页 / 新建订单时可见</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════
// SkillCard 通用卡片组件
// ════════════════════════════════════════════════

function SkillCard({
  title,
  icon,
  loading,
  error,
  result,
  shadow,
  onRefresh,
}: {
  title: string;
  icon: string;
  loading: boolean;
  error: string | null;
  result: SkillResult | null;
  shadow: boolean;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* 标题栏 */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-indigo-50/50 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>{icon}</span>
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            {shadow && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">
                SHADOW
              </span>
            )}
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-xs text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
            title="重新计算"
          >
            ↻
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="p-4">
        {loading && (
          <p className="text-xs text-gray-400">加载中...</p>
        )}

        {!loading && error && (
          <p className="text-xs text-amber-600">⚠️ {error}</p>
        )}

        {!loading && !error && shadow && (
          <p className="text-xs text-purple-600">
            🔬 Shadow 模式 — 后台已运行，结果暂不展示
          </p>
        )}

        {!loading && !error && !shadow && !result && (
          <p className="text-xs text-gray-400">暂无数据</p>
        )}

        {!loading && !error && result && (
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

            <div className="mt-3 flex items-center justify-between text-[10px] text-gray-400">
              <span>来源: {result.source} · 置信度: {result.confidence}%</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FindingItem({ finding }: { finding: SkillFinding }) {
  return (
    <li className={`text-xs px-2 py-1.5 rounded border ${SEV_COLOR[finding.severity]}`}>
      <div className="flex items-start gap-1.5">
        <span className="shrink-0">{SEV_LABEL[finding.severity]}</span>
        <div className="flex-1 min-w-0">
          <p className="font-medium">{finding.label}</p>
          {finding.detail && (
            <p className="text-[11px] mt-0.5 opacity-90">{finding.detail}</p>
          )}
          {finding.blocksStepName && (
            <p className="text-[10px] mt-0.5 opacity-75">
              卡 {finding.blocksStepName}
              {finding.daysToBlocker !== undefined && finding.daysToBlocker >= 0 && (
                <span className="font-bold"> · 剩 {finding.daysToBlocker} 天</span>
              )}
              {finding.whoShouldFix && (
                <span> · 责任：{finding.whoShouldFix}</span>
              )}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
