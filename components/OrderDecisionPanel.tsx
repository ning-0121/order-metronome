'use client';

/**
 * OrderDecisionPanel — 订单决策评审面板（仅 admin）
 *
 * 严格纪律：
 *   - 不调 AI、不真阻塞 workflow
 *   - 所有写操作走 app/actions/order-decision.ts
 *   - override 必须填写 reason（≥5 字符），双写 decision_feedback + order_logs 在 action 层处理
 */

import { useState, useEffect, useCallback } from 'react';
import {
  runOrderDecisionReview,
  overrideDecision,
  getLatestOrderDecisionReview,
  getOrderDecisionHistory,
} from '@/app/actions/order-decision';
import type { DecisionResult, OrderDecisionReviewRow, RuleFlag, AuditSummary } from '@/lib/types/decision';

interface Props {
  orderId: string;
  isAdmin: boolean;
}

// ─── 样式常量 ────────────────────────────────────────────────────────────────

const DECISION_STYLE = {
  PROCEED: { border: 'border-green-200', bg: 'bg-green-50', badge: 'bg-green-100 text-green-800', label: '推进', icon: '✅' },
  CAUTION: { border: 'border-amber-200', bg: 'bg-amber-50', badge: 'bg-amber-100 text-amber-800', label: '注意', icon: '⚠️' },
  STOP:    { border: 'border-red-200',   bg: 'bg-red-50',   badge: 'bg-red-100 text-red-800',     label: '停止', icon: '🛑' },
} as const;

const SEVERITY_STYLE = {
  high:   'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-gray-100 text-gray-600',
} as const;

const URGENCY_LABEL = {
  now:         { text: '立即处理', cls: 'text-red-600 font-semibold' },
  within_24h:  { text: '24h内',   cls: 'text-amber-600' },
  within_3d:   { text: '3天内',   cls: 'text-gray-500' },
} as const;

const AUDIT_LABELS: Record<string, string> = {
  business:    '🏢 商业',
  financial:   '💰 财务',
  feasibility: '🔧 可行性',
};

const REVIEW_TYPE_LABELS: Record<string, string> = {
  pre_kickoff:    '启动前',
  mid_production: '产中',
  pre_shipment:   '出运前',
  manual:         '手动触发',
};

// ─── 工具 ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function OrderDecisionPanel({ orderId, isAdmin }: Props) {
  const [review, setReview] = useState<OrderDecisionReviewRow | null>(null);
  const [history, setHistory] = useState<OrderDecisionReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [overrideMode, setOverrideMode] = useState<'override_to_proceed' | 'override_to_stop' | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getLatestOrderDecisionReview(orderId);
    if (res.error) setError(res.error);
    else setReview(res.data ?? null);
    setLoading(false);
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  async function handleRun(forceFresh = false) {
    setRunning(true);
    setError(null);
    setSuccessMsg(null);
    const res = await runOrderDecisionReview(orderId, { forceFresh });
    if (res.error) setError(res.error);
    else {
      setSuccessMsg('评审完成');
      await load();
      if (showHistory) await loadHistory();
    }
    setRunning(false);
  }

  async function loadHistory() {
    setHistoryLoading(true);
    const res = await getOrderDecisionHistory(orderId, 10);
    if (!res.error) setHistory(res.data ?? []);
    setHistoryLoading(false);
  }

  async function handleToggleHistory() {
    if (!showHistory && history.length === 0) await loadHistory();
    setShowHistory(v => !v);
  }

  async function handleOverride() {
    if (!review || !overrideMode) return;
    if (overrideReason.trim().length < 5) {
      setError('请填写覆写原因（不少于 5 个字符）');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await overrideDecision(review.id, overrideMode, overrideReason.trim());
    if (res.error) {
      setError(res.error);
    } else {
      setSuccessMsg('决策已覆写');
      setOverrideMode(null);
      setOverrideReason('');
      await load();
    }
    setSubmitting(false);
  }

  if (!isAdmin) return null;

  return (
    <div className="rounded-xl border border-indigo-200 bg-white overflow-hidden">
      {/* ── 标题栏 ── */}
      <div className="flex items-center justify-between px-5 py-3 bg-indigo-50 border-b border-indigo-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-indigo-800">🔍 订单决策评审</span>
          {review && (
            <span className="text-xs text-indigo-500">
              {REVIEW_TYPE_LABELS[review.review_type] ?? review.review_type}
              {' · '}
              {fmtDate(review.created_at)}
            </span>
          )}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-500 font-medium">Admin Only</span>
        </div>
        <div className="flex items-center gap-2">
          {review && (
            <button
              onClick={() => handleRun(true)}
              disabled={running}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {running ? '评审中…' : '重新评审'}
            </button>
          )}
        </div>
      </div>

      {/* ── 消息条 ── */}
      {(error || successMsg) && (
        <div className={`px-5 py-2 text-xs ${error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
          {error ?? successMsg}
        </div>
      )}

      {/* ── 主体 ── */}
      <div className="p-5">
        {loading ? (
          <Skeleton />
        ) : !review ? (
          <EmptyState onRun={() => handleRun(false)} running={running} />
        ) : (
          <ReviewDetail
            review={review}
            overrideMode={overrideMode}
            overrideReason={overrideReason}
            submitting={submitting}
            showHistory={showHistory}
            history={history}
            historyLoading={historyLoading}
            onSetOverrideMode={setOverrideMode}
            onSetOverrideReason={setOverrideReason}
            onOverride={handleOverride}
            onToggleHistory={handleToggleHistory}
          />
        )}
      </div>
    </div>
  );
}

// ─── 空状态 ──────────────────────────────────────────────────────────────────

function EmptyState({ onRun, running }: { onRun: () => void; running: boolean }) {
  return (
    <div className="text-center py-8">
      <p className="text-sm text-gray-400 mb-3">暂无决策评审记录</p>
      <button
        onClick={onRun}
        disabled={running}
        className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {running ? '评审中…' : '首次评审'}
      </button>
    </div>
  );
}

// ─── 评审详情 ─────────────────────────────────────────────────────────────────

interface ReviewDetailProps {
  review: OrderDecisionReviewRow;
  overrideMode: 'override_to_proceed' | 'override_to_stop' | null;
  overrideReason: string;
  submitting: boolean;
  showHistory: boolean;
  history: OrderDecisionReviewRow[];
  historyLoading: boolean;
  onSetOverrideMode: (m: 'override_to_proceed' | 'override_to_stop' | null) => void;
  onSetOverrideReason: (r: string) => void;
  onOverride: () => void;
  onToggleHistory: () => void;
}

function ReviewDetail({
  review, overrideMode, overrideReason, submitting,
  showHistory, history, historyLoading,
  onSetOverrideMode, onSetOverrideReason, onOverride, onToggleHistory,
}: ReviewDetailProps) {
  const result = review.result_json;
  const ds = DECISION_STYLE[review.decision] ?? DECISION_STYLE.CAUTION;

  return (
    <div className="space-y-4">
      {/* ── 决策摘要行 ── */}
      <div className={`flex items-center gap-3 p-3 rounded-lg border ${ds.bg} ${ds.border}`}>
        <span className="text-xl">{ds.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${ds.badge}`}>
              {ds.label}
            </span>
            <span className="text-xs text-gray-500">置信度 {review.confidence}%</span>
            <span className="text-xs text-gray-400">· 来源：规则引擎</span>
            <span className="text-xs text-gray-400">· AI：未使用</span>
            {result.costUsd === null && (
              <span className="text-xs text-gray-400">· 费用：¥0</span>
            )}
            {review.override_status === 'approved' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600">已覆写</span>
            )}
          </div>
          {result.explanation && (
            <p className="text-xs text-gray-600 mt-1.5 leading-relaxed whitespace-pre-line">
              {result.explanation}
            </p>
          )}
        </div>
        {/* 置信度进度条 */}
        <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0 w-16">
          <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${review.confidence >= 70 ? 'bg-green-500' : review.confidence >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
              style={{ width: `${review.confidence}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-400">{review.confidence}%</span>
        </div>
      </div>

      {/* ── 三栏审核摘要 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(['business', 'financial', 'feasibility'] as const).map(cat => {
          const audit: AuditSummary = (review as any)[`${cat}_audit`] ?? { flags: [], summary: '未评估' };
          const hasFlags = audit.flags.length > 0;
          return (
            <div
              key={cat}
              className={`rounded-lg border p-3 ${hasFlags ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-gray-600">{AUDIT_LABELS[cat]}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${hasFlags ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                  {hasFlags ? audit.summary : '通过'}
                </span>
              </div>
              {audit.flags.length > 0 && (
                <div className="space-y-1">
                  {audit.flags.slice(0, 3).map(flag => (
                    <div key={flag.id} className="flex items-start gap-1.5">
                      <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 mt-0.5 ${SEVERITY_STYLE[flag.severity]}`}>
                        {flag.severity === 'high' ? '高' : flag.severity === 'medium' ? '中' : '低'}
                      </span>
                      <p className="text-[11px] text-gray-700 leading-snug">{flag.message}</p>
                    </div>
                  ))}
                  {audit.flags.length > 3 && (
                    <p className="text-[10px] text-gray-400">+{audit.flags.length - 3} 条</p>
                  )}
                </div>
              )}
              {audit.flags.length === 0 && (
                <p className="text-[11px] text-green-600">所有规则通过</p>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 必要行动（最多 3 条） ── */}
      {result.requiredActions && result.requiredActions.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-xs font-semibold text-gray-600 mb-2">📋 必要行动</p>
          <div className="space-y-1.5">
            {result.requiredActions.slice(0, 3).map((a, i) => {
              const urg = URGENCY_LABEL[a.urgency] ?? URGENCY_LABEL.within_3d;
              return (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className={`flex-shrink-0 mt-0.5 ${urg.cls}`}>[{urg.text}]</span>
                  <span className="text-gray-700">{a.action}</span>
                  <span className="text-gray-400 flex-shrink-0">→ {a.targetRole}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 覆写区 ── */}
      <OverrideSection
        review={review}
        overrideMode={overrideMode}
        overrideReason={overrideReason}
        submitting={submitting}
        onSetMode={onSetOverrideMode}
        onSetReason={onSetOverrideReason}
        onSubmit={onOverride}
      />

      {/* ── 历史入口 ── */}
      <div className="pt-1">
        <button
          onClick={onToggleHistory}
          className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          {showHistory ? '▲ 收起历史' : '▼ 查看历史评审'}
        </button>
        {showHistory && (
          <div className="mt-2">
            {historyLoading ? (
              <p className="text-xs text-gray-400 py-2">加载中…</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">暂无历史记录</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {history.map(h => {
                  const hds = DECISION_STYLE[h.decision] ?? DECISION_STYLE.CAUTION;
                  return (
                    <div key={h.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${hds.bg} ${hds.border}`}>
                      <span>{hds.icon}</span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${hds.badge}`}>{hds.label}</span>
                      <span className="text-gray-500">{h.confidence}%</span>
                      <span className="text-gray-400">{REVIEW_TYPE_LABELS[h.review_type] ?? h.review_type}</span>
                      {h.override_status === 'approved' && (
                        <span className="text-[9px] text-indigo-500">已覆写</span>
                      )}
                      <span className="ml-auto text-gray-400 flex-shrink-0">{fmtDate(h.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 覆写区组件 ──────────────────────────────────────────────────────────────

interface OverrideSectionProps {
  review: OrderDecisionReviewRow;
  overrideMode: 'override_to_proceed' | 'override_to_stop' | null;
  overrideReason: string;
  submitting: boolean;
  onSetMode: (m: 'override_to_proceed' | 'override_to_stop' | null) => void;
  onSetReason: (r: string) => void;
  onSubmit: () => void;
}

function OverrideSection({ review, overrideMode, overrideReason, submitting, onSetMode, onSetReason, onSubmit }: OverrideSectionProps) {
  const alreadyOverridden = review.override_status === 'approved';

  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-gray-500">管理员覆写</p>
        {alreadyOverridden && (
          <span className="text-[10px] text-indigo-500">
            已覆写 · {review.override_reason?.slice(0, 20)}{(review.override_reason?.length ?? 0) > 20 ? '…' : ''}
          </span>
        )}
      </div>

      {!overrideMode ? (
        <div className="flex gap-2">
          <button
            onClick={() => onSetMode('override_to_proceed')}
            className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            覆写为推进
          </button>
          <button
            onClick={() => onSetMode('override_to_stop')}
            className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            覆写为停止
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-600">
            将覆写为：<strong>{overrideMode === 'override_to_proceed' ? '✅ 推进' : '🛑 停止'}</strong>
          </p>
          <textarea
            value={overrideReason}
            onChange={e => onSetReason(e.target.value)}
            placeholder="必须填写覆写原因（≥5字符），将写入审计日志"
            rows={2}
            className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="flex gap-2">
            <button
              onClick={onSubmit}
              disabled={submitting || overrideReason.trim().length < 5}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? '提交中…' : '确认覆写'}
            </button>
            <button
              onClick={() => { onSetMode(null); onSetReason(''); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-14 bg-gray-100 rounded-lg" />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map(i => <div key={i} className="h-20 bg-gray-100 rounded-lg" />)}
      </div>
      <div className="h-10 bg-gray-100 rounded-lg" />
    </div>
  );
}
