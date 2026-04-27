'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { DailyTask, TaskType } from '@/lib/services/types';

// ── 任务类型配置 ───────────────────────────────────────────────
const TASK_TYPE_CONFIG: Record<TaskType, { icon: string; label: string; color: string }> = {
  milestone_overdue:  { icon: '🔴', label: '里程碑逾期', color: 'border-l-red-500' },
  milestone_due_today:{ icon: '🟡', label: '今日到期',   color: 'border-l-amber-400' },
  customer_followup:  { icon: '👤', label: '客户跟进',   color: 'border-l-blue-400' },
  delay_approval:     { icon: '⏳', label: '延期审批',   color: 'border-l-orange-400' },
  quote_approval:     { icon: '💰', label: '报价审批',   color: 'border-l-green-400' },
  profit_warning:     { icon: '📉', label: '利润预警',   color: 'border-l-rose-500' },
  system_alert:       { icon: '🚨', label: '系统告警',   color: 'border-l-red-600' },
  email_action:       { icon: '📧', label: '邮件待处理', color: 'border-l-purple-400' },
};

const PRIORITY_LABEL: Record<number, { text: string; badge: string }> = {
  1: { text: '紧急', badge: 'bg-red-100 text-red-700' },
  2: { text: '重要', badge: 'bg-amber-100 text-amber-700' },
  3: { text: '普通', badge: 'bg-gray-100 text-gray-500' },
};

interface TaskCardProps {
  task: DailyTask;
  onDone: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
}

export function TaskCard({ task, onDone, onSnooze, onDismiss }: TaskCardProps) {
  const [loading, setLoading] = useState(false);
  const config = TASK_TYPE_CONFIG[task.task_type] ?? { icon: '📌', label: task.task_type, color: 'border-l-gray-300' };
  const priorityInfo = PRIORITY_LABEL[task.priority] ?? PRIORITY_LABEL[3];

  async function handle(action: 'done' | 'snoozed' | 'dismissed') {
    setLoading(true);
    try {
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString();
      await fetch('/api/services/daily-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          taskId: task.id,
          status: action,
          ...(action === 'snoozed' ? { snoozedUntil: tomorrowStr } : {}),
        }),
      });
      if (action === 'done') onDone(task.id);
      else if (action === 'snoozed') onSnooze(task.id);
      else onDismiss(task.id);
    } catch (e) {
      alert('操作失败，请刷新重试');
    }
    setLoading(false);
  }

  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${config.color} shadow-sm p-4 flex gap-3`}>
      {/* 图标 + 类型标记 */}
      <div className="pt-0.5 text-xl flex-shrink-0">{config.icon}</div>

      <div className="flex-1 min-w-0">
        {/* 标题行 */}
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-gray-800 leading-snug">{task.title}</p>
          <div className="flex gap-1.5 flex-shrink-0">
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${priorityInfo.badge}`}>
              {priorityInfo.text}
            </span>
          </div>
        </div>

        {/* 描述 */}
        {task.description && (
          <p className="text-xs text-gray-500 mt-1">{task.description}</p>
        )}

        {/* 操作行 */}
        <div className="flex items-center gap-2 mt-3">
          {/* 主操作 - 去处理 */}
          {task.action_url ? (
            <Link
              href={task.action_url}
              className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
            >
              {task.action_label || '去处理'}
            </Link>
          ) : null}

          {/* 完成 */}
          <button
            onClick={() => handle('done')}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 font-medium hover:bg-green-100 transition-colors disabled:opacity-50"
          >
            ✓ 完成
          </button>

          {/* 推迟 */}
          <button
            onClick={() => handle('snoozed')}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            明天再说
          </button>

          {/* 忽略（普通任务才显示） */}
          {task.priority === 3 && (
            <button
              onClick={() => handle('dismissed')}
              disabled={loading}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            >
              忽略
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
