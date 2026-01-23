'use client';

import Link from 'next/link';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { isMilestoneOverdue, extractBlockedReason } from '@/lib/domain/milestone-helpers';
import type { Milestone, Order } from '@/lib/types';

interface MilestoneCardProps {
  milestone: Milestone & { orders?: Order };
}

export function MilestoneCard({ milestone }: MilestoneCardProps) {
  const order = milestone.orders;
  
  // 状态颜色映射（只使用中文状态）
  const getStatusColor = (status: string): string => {
    if (status === '未开始') return 'bg-gray-100 text-gray-800';
    if (status === '进行中') return 'bg-blue-100 text-blue-800';
    if (status === '已完成') return 'bg-green-100 text-green-800';
    if (status === '卡住') return 'bg-orange-100 text-orange-800';
    return 'bg-gray-100 text-gray-800';
  };
  
  const overdue = isMilestoneOverdue(milestone);

  return (
    <Link href={`/orders/${order?.id}#milestone-${milestone.id}`}>
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <h3 className="font-semibold text-lg">{milestone.name}</h3>
          {milestone.is_critical && (
            <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
              Critical
            </span>
          )}
        </div>
        
        {order && (
          <p className="text-sm text-gray-600 mb-2">
            Order: {order.order_no}
          </p>
        )}
        
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-2 py-1 rounded ${getStatusColor(milestone.status)}`}>
            {milestone.status}
          </span>
        </div>
        
        <div className="text-sm text-gray-600 space-y-1">
          {milestone.due_at && <p>Due: {formatDate(milestone.due_at)}</p>}
          <p>Owner: {milestone.owner_role}</p>
          {milestone.status === '卡住' && milestone.notes && (
            <p className="text-orange-600">
              卡住原因: {extractBlockedReason(milestone.notes) || milestone.notes}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
