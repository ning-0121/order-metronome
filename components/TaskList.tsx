'use client';

import { useState } from 'react';
import { TaskCard } from './TaskCard';
import type { DailyTask } from '@/lib/services/types';

interface TaskListProps {
  initialTasks: DailyTask[];
}

export function TaskList({ initialTasks }: TaskListProps) {
  const [tasks, setTasks] = useState<DailyTask[]>(initialTasks);
  const [filter, setFilter] = useState<'all' | 'urgent'>('all');

  const visible = filter === 'urgent'
    ? tasks.filter(t => t.priority === 1)
    : tasks;

  const urgentCount = tasks.filter(t => t.priority === 1).length;

  function removeTask(taskId: string) {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <p className="text-lg font-semibold text-gray-700">今天没有待办任务</p>
        <p className="text-sm text-gray-400 mt-1">好好休息，明天继续加油</p>
      </div>
    );
  }

  return (
    <div>
      {/* 筛选栏 */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setFilter('all')}
          className={`text-sm px-3 py-1.5 rounded-full font-medium transition-colors ${
            filter === 'all'
              ? 'bg-gray-800 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          全部 {tasks.length}
        </button>
        {urgentCount > 0 && (
          <button
            onClick={() => setFilter('urgent')}
            className={`text-sm px-3 py-1.5 rounded-full font-medium transition-colors ${
              filter === 'urgent'
                ? 'bg-red-600 text-white'
                : 'bg-red-50 text-red-600 hover:bg-red-100'
            }`}
          >
            🚨 紧急 {urgentCount}
          </button>
        )}
      </div>

      {/* 任务列表 */}
      <div className="space-y-3">
        {visible.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            onDone={removeTask}
            onSnooze={removeTask}
            onDismiss={removeTask}
          />
        ))}
      </div>

      {visible.length === 0 && filter === 'urgent' && (
        <div className="text-center py-10 text-gray-400 text-sm">没有紧急任务 ✓</div>
      )}
    </div>
  );
}
