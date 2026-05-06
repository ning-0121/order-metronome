'use client';

/**
 * Runtime Risk Card — Phase 1 Day 6 UI
 *
 * 设计原则：
 *  - 不大面积红色刺激员工
 *  - 显示「为什么 / 哪个节点 / 影响交付吗 / 下一步谁做什么」
 *  - 没有 runtime 数据时父组件渲染老卡（这里只负责"有数据就显示"）
 *
 * 数据来源：runtime_orders.explain_json
 */

import type { ConfidenceExplain, RuntimeRiskLevel } from '@/lib/runtime/types';

interface Props {
  confidence: number;
  riskLevel: RuntimeRiskLevel;
  predictedFinishDate?: string | null;
  bufferDays?: number | null;
  explain: ConfidenceExplain;
}

// 温和色板：避免大面积红色
const STYLE: Record<RuntimeRiskLevel, {
  cardBg: string;
  cardBorder: string;
  badgeBg: string;
  badgeText: string;
  barBg: string;
  barFg: string;
  ring: string;
}> = {
  green: {
    cardBg: 'bg-green-50',
    cardBorder: 'border-green-200',
    badgeBg: 'bg-green-100',
    badgeText: 'text-green-800',
    barBg: 'bg-green-100',
    barFg: 'bg-green-500',
    ring: 'ring-green-100',
  },
  yellow: {
    cardBg: 'bg-amber-50',
    cardBorder: 'border-amber-200',
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-800',
    barBg: 'bg-amber-100',
    barFg: 'bg-amber-500',
    ring: 'ring-amber-100',
  },
  orange: {
    cardBg: 'bg-orange-50',
    cardBorder: 'border-orange-200',
    badgeBg: 'bg-orange-100',
    badgeText: 'text-orange-800',
    barBg: 'bg-orange-100',
    barFg: 'bg-orange-500',
    ring: 'ring-orange-100',
  },
  red: {
    // 温和粉/玫瑰，而不是刺眼的鲜红
    cardBg: 'bg-rose-50',
    cardBorder: 'border-rose-200',
    badgeBg: 'bg-rose-100',
    badgeText: 'text-rose-800',
    barBg: 'bg-rose-100',
    barFg: 'bg-rose-500',
    ring: 'ring-rose-100',
  },
  gray: {
    cardBg: 'bg-gray-50',
    cardBorder: 'border-gray-200',
    badgeBg: 'bg-gray-100',
    badgeText: 'text-gray-700',
    barBg: 'bg-gray-100',
    barFg: 'bg-gray-400',
    ring: 'ring-gray-100',
  },
};

const WEIGHT_LABEL: Record<string, string> = {
  critical: '关键',
  high: '重要',
  medium: '中等',
  low: '次要',
};

export function RuntimeRiskCard({
  confidence,
  riskLevel,
  predictedFinishDate,
  bufferDays,
  explain,
}: Props) {
  const s = STYLE[riskLevel] || STYLE.gray;
  const reasons = (explain.reasons || []).slice(0, 3); // 顶 3 条最重要
  const blocker = explain.next_blocker;
  const action = explain.next_action;

  return (
    <div className={`rounded-xl border ${s.cardBorder} ${s.cardBg} p-4 ring-1 ${s.ring}`}>
      {/* 顶部：headline + confidence 百分比 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">⚡ 交付置信度</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badgeBg} ${s.badgeText}`}>
          {confidence}%
        </span>
      </div>

      {/* 一句话总结：从 explain.headline 去掉 emoji 重新组合，保持温和文案 */}
      <p className="text-sm font-semibold text-gray-900 mb-1">
        {explain.headline}
      </p>

      {/* 进度条：直观看 confidence 落在哪 */}
      <div className={`w-full h-1.5 rounded-full ${s.barBg} mb-3`}>
        <div className={`h-full rounded-full ${s.barFg}`} style={{ width: `${confidence}%` }} />
      </div>

      {/* 原因（前 3 条） */}
      {reasons.length > 0 && (
        <div className="space-y-1 mb-3">
          {reasons.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px]">
              <span className={`flex-shrink-0 inline-block w-1 h-1 rounded-full mt-1.5 ${s.barFg}`} />
              <div className="flex-1 min-w-0">
                <span className="text-gray-700">{r.label}</span>
                <span className="text-gray-400 ml-1">
                  ({r.delta > 0 ? '+' : ''}{r.delta} · {WEIGHT_LABEL[r.weight] || r.weight})
                </span>
              </div>
            </div>
          ))}
          {explain.reasons.length > 3 && (
            <p className="text-[10px] text-gray-400 pl-3">
              另有 {explain.reasons.length - 3} 项次要因素
            </p>
          )}
        </div>
      )}

      {/* next_blocker：哪个节点卡着 */}
      {blocker && (
        <div className="rounded-lg bg-white/70 border border-gray-200 p-2.5 mb-2">
          <div className="flex items-start gap-2">
            <span className="text-[10px] font-medium text-gray-500 mt-0.5">下一关键节点</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-gray-800">{blocker.name}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">
                {blocker.daysOverdue > 0 && (
                  <span className="text-rose-600 font-medium">已超期 {blocker.daysOverdue} 天</span>
                )}
                {blocker.daysOverdue === 0 && blocker.daysUntil > 0 && (
                  <span>还有 {blocker.daysUntil} 天到期</span>
                )}
                {blocker.status && (blocker.status === 'blocked' || blocker.status === '阻塞') && (
                  <span className="ml-1 text-rose-600 font-medium">· 阻塞中</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* next_action：下一步建议（像帮助，而不是责备） */}
      {action && (
        <div className="flex items-start gap-2 text-[11px] leading-relaxed">
          <span className="text-amber-600 flex-shrink-0">💡</span>
          <span className="text-gray-700">{action}</span>
        </div>
      )}

      {/* 底部 buffer / 预计完工 */}
      {(bufferDays !== null && bufferDays !== undefined) || predictedFinishDate ? (
        <div className="mt-3 pt-2 border-t border-gray-200/60 flex justify-between text-[10px] text-gray-500">
          {predictedFinishDate && (
            <span>预计完工 {predictedFinishDate}</span>
          )}
          {bufferDays !== null && bufferDays !== undefined && (
            <span>
              {bufferDays >= 0 ? `距出厂 ${bufferDays} 天` : `已过 ${Math.abs(bufferDays)} 天`}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
