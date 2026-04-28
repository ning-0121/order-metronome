'use client';

/**
 * 邮件晨报卡片 — "我的节拍"顶部
 *
 * 状态机：
 *   1. 无缓存：显示"生成今日晨报"大按钮
 *   2. 有缓存：展示内容 + "刷新最新（约¥0.5）"小按钮
 *   3. 生成中：loading + 提示
 *   4. 失败：错误信息 + 重试
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { generateMyBriefingAction } from '@/app/actions/briefing';

interface BriefingContent {
  summaryText: string;
  topActions: string[];
  urgentItems: string[];
  stats: {
    newEmailsCount: number;
    activeOrdersCount: number;
    todayDueMilestones: number;
    overdueMilestones: number;
    pendingDelays: number;
  };
}

interface BriefingRecord {
  id: string;
  briefingDate: string;
  content: BriefingContent;
  summaryText: string;
  totalEmails: number;
  urgentCount: number;
  createdAt: string;
  ageMinutes: number;
}

interface Props {
  initialBriefing: BriefingRecord | null;
  userName: string;
}

function formatAge(minutes: number): string {
  if (minutes < 1) return '刚刚生成';
  if (minutes < 60) return `${minutes} 分钟前生成`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前生成`;
  return '已超过 24 小时（请刷新）';
}

export function MorningBriefingCard({ initialBriefing, userName }: Props) {
  const router = useRouter();
  const [briefing, setBriefing] = useState<BriefingRecord | null>(initialBriefing);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showConfirmRefresh, setShowConfirmRefresh] = useState(false);

  function generate(force: boolean) {
    setError(null);
    setShowConfirmRefresh(false);
    startTransition(async () => {
      const res = await generateMyBriefingAction(force);
      if (res.error) {
        setError(res.error);
      } else if (res.data) {
        setBriefing(res.data);
        // 让 server 也刷新一次，让其他组件看到新数据
        router.refresh();
      }
    });
  }

  // ── 状态 1：无缓存（首次） ───────────────────────────────
  if (!briefing) {
    return (
      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-5 mb-6">
        <div className="flex items-start gap-3">
          <span className="text-3xl flex-shrink-0">☀️</span>
          <div className="flex-1">
            <h3 className="text-base font-bold text-amber-900">{userName}，今天的晨报还没生成</h3>
            <p className="text-sm text-amber-700 mt-1">
              点击下方按钮，AI 会基于昨日邮件 + 今日待办 + 风险信号，
              <br className="hidden md:inline" />
              帮你生成 5 分钟看完即上手的工作简报。
            </p>
            <p className="text-xs text-amber-600/70 mt-2">
              ⓘ 单次生成约消耗 ¥0.3-0.5 token，每日缓存复用
            </p>
            <div className="mt-3">
              <button
                onClick={() => generate(false)}
                disabled={pending}
                className="px-5 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 transition-colors disabled:opacity-60"
              >
                {pending ? '✨ AI 思考中...' : '☕ 生成今日晨报'}
              </button>
              {error && (
                <p className="text-xs text-red-600 mt-2">⚠ {error}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 状态 2：有缓存 → 展示 ────────────────────────────────
  const c = briefing.content;
  const ageStr = formatAge(briefing.ageMinutes);
  const stale = briefing.ageMinutes >= 60 * 8; // 8 小时算"较旧"

  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5 mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">☀️</span>
          <h3 className="text-base font-bold text-blue-900">今日晨报 · {userName}</h3>
          <span className={`text-xs ${stale ? 'text-amber-600' : 'text-blue-600/70'}`}>
            {ageStr}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {showConfirmRefresh ? (
            <>
              <span className="text-xs text-gray-600">确认刷新？约消耗 ¥0.5</span>
              <button
                onClick={() => generate(true)}
                disabled={pending}
                className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {pending ? '生成中...' : '确认'}
              </button>
              <button
                onClick={() => setShowConfirmRefresh(false)}
                className="text-xs px-3 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                取消
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowConfirmRefresh(true)}
              disabled={pending}
              className="text-xs px-3 py-1 rounded text-blue-600 hover:bg-blue-100 disabled:opacity-60"
              title="约消耗 ¥0.5 token"
            >
              🔄 刷新最新
            </button>
          )}
        </div>
      </div>

      {/* 核心摘要 */}
      <div className="bg-white/70 rounded-lg p-4 mb-3">
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
          {c.summaryText}
        </p>
      </div>

      {/* 紧急 */}
      {c.urgentItems && c.urgentItems.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          <p className="text-xs font-bold text-red-800 mb-1.5">🚨 紧急</p>
          <ul className="space-y-1">
            {c.urgentItems.map((item, i) => (
              <li key={i} className="text-sm text-red-700 leading-snug">• {item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 今日重点行动 */}
      {c.topActions && c.topActions.length > 0 && (
        <div className="bg-white/70 rounded-lg p-3 mb-3">
          <p className="text-xs font-bold text-gray-700 mb-1.5">✅ 今日重点行动</p>
          <ul className="space-y-1">
            {c.topActions.map((action, i) => (
              <li key={i} className="text-sm text-gray-700 leading-snug">
                <span className="text-blue-500 font-semibold mr-1">{i + 1}.</span>
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 数据快照 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
        {[
          { label: '昨日新邮件', value: c.stats?.newEmailsCount, color: 'text-purple-600' },
          { label: '活跃订单', value: c.stats?.activeOrdersCount, color: 'text-blue-600' },
          { label: '今日到期', value: c.stats?.todayDueMilestones, color: 'text-amber-600' },
          { label: '已超期', value: c.stats?.overdueMilestones, color: c.stats?.overdueMilestones > 0 ? 'text-red-600' : 'text-gray-400' },
          { label: '延期待批', value: c.stats?.pendingDelays, color: 'text-orange-600' },
        ].map(s => (
          <div key={s.label} className="bg-white/60 rounded-lg p-2">
            <p className={`text-lg font-bold ${s.color}`}>{s.value ?? 0}</p>
            <p className="text-xs text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>

      {error && (
        <p className="text-xs text-red-600 mt-3">⚠ 刷新失败：{error}</p>
      )}
    </div>
  );
}
