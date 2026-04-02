'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/utils/date';
import { getRoleLabel } from '@/lib/utils/i18n';
import { isBlockedStatus } from '@/lib/domain/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface TodayMustHandleMilestone {
  id: string;
  order_id: string;
  name: string;
  owner_role: string;
  owner_user_id: string | null;
  owner_user: {
    user_id: string;
    email: string;
    full_name: string | null;
  } | null;
  due_at: string;
  status: string;
  order_no: string;
  customer_name: string;
  has_pending_delay: boolean;
}

interface TodayMustHandleProps {
  milestones: TodayMustHandleMilestone[];
}

export function TodayMustHandle({ milestones }: TodayMustHandleProps) {
  const router = useRouter();
  const [nudging, setNudging] = useState<Record<string, boolean>>({});

  async function handleNudge(milestoneId: string) {
    setNudging((prev) => ({ ...prev, [milestoneId]: true }));
    
    try {
      const response = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestone_id: milestoneId }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        alert(data.error || '发送提醒失败');
      } else {
        alert('提醒已发送');
        router.refresh();
      }
    } catch (error: any) {
      alert('错误: ' + error.message);
    } finally {
      setNudging((prev) => ({ ...prev, [milestoneId]: false }));
    }
  }

  if (milestones.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">今日必须处理</h2>
        <p className="text-gray-600">暂无需要今日处理的节点</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="text-2xl font-semibold mb-4 text-gray-900">今日必须处理</h2>
      <p className="text-sm text-gray-600 mb-4">
        共 {milestones.length} 个节点需要立即处理
      </p>
      
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {milestones.map((milestone) => {
          const isNudging = nudging[milestone.id] || false;
          const isOverdue = new Date(milestone.due_at) < new Date();
          const isDueToday = new Date(milestone.due_at).toDateString() === new Date().toDateString();
          
          return (
            <div
              key={milestone.id}
              className="bg-white rounded-lg border border-red-300 p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Link
                      href={`/orders/${milestone.order_id}?tab=progress#milestone-${milestone.id}`}
                      className="font-semibold text-gray-900 hover:text-blue-600"
                    >
                      {milestone.name}
                    </Link>
                    {isBlockedStatus(milestone.status) && (
                      <span className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded font-medium">
                        已阻塞
                      </span>
                    )}
                    {isOverdue && (
                      <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded font-medium">
                        逾期
                      </span>
                    )}
                    {!isOverdue && isDueToday && (
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded font-medium">
                        今日到期
                      </span>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-sm text-gray-700 mb-2">
                    <div>
                      <span className="font-medium text-gray-600">订单：</span>{' '}
                      <Link
                        href={`/orders/${milestone.order_id}`}
                        className="text-blue-600 hover:text-blue-700"
                      >
                        {milestone.order_no}
                      </Link>
                    </div>
                    <div>
                      <span className="font-medium text-gray-600">截止日期：</span>{' '}
                      <span className={isOverdue ? 'text-red-700 font-semibold' : ''}>
                        {formatDate(milestone.due_at, 'yyyy-MM-dd HH:mm')}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-600">责任人：</span>{' '}
                      <span className="text-gray-900">{getRoleLabel(milestone.owner_role)}</span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-600">执行人：</span>{' '}
                      <span className="text-gray-900">
                        {milestone.owner_user_id ? (
                          milestone.owner_user ? (
                            (milestone.owner_user as any).name ?? (milestone.owner_user as any).full_name ?? milestone.owner_user.email
                          ) : (
                            '加载中...'
                          )
                        ) : (
                          <span className="text-gray-600 italic">未分配</span>
                        )}
                      </span>
                    </div>
                  </div>
                  
                  {milestone.has_pending_delay && (
                    <div className="mt-2 p-2 bg-yellow-100 border border-yellow-300 rounded text-sm text-yellow-800">
                      ⚠️ 有待处理的延期申请
                    </div>
                  )}
                </div>
                
                <div className="ml-4 flex flex-col gap-2">
                  <Link
                    href={`/orders/${milestone.order_id}?tab=progress#milestone-${milestone.id}`}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                  >
                    查看详情
                  </Link>
                  <button
                    onClick={() => handleNudge(milestone.id)}
                    disabled={isNudging}
                    className="text-sm text-purple-600 hover:text-purple-700 font-medium disabled:opacity-50 whitespace-nowrap"
                  >
                    {isNudging ? '发送中...' : '📧 提醒'}
                  </button>
                  {milestone.has_pending_delay && (
                    <Link
                      href={`/orders/${milestone.order_id}#delay-requests`}
                      className="text-sm text-orange-600 hover:text-orange-700 font-medium whitespace-nowrap"
                    >
                      审批延期
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
