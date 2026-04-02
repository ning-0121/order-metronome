'use client';

import Link from 'next/link';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { isMilestoneOverdue, extractBlockedReason } from '@/lib/domain/milestone-helpers';
import { normalizeMilestoneStatus, isBlockedStatus } from '@/lib/domain/types';
import type { Milestone, Order } from '@/lib/types';

interface MilestoneCardProps {
  milestone: Milestone & { orders?: Order };
}

export function MilestoneCard({ milestone }: MilestoneCardProps) {
  const order = milestone.orders;

  // 状态颜色映射（标准化后判断）
  const getStatusColor = (status: string): string => {
    const normalized = normalizeMilestoneStatus(status);
    if (normalized === '未开始') return 'bg-gray-100 text-gray-800';
    if (normalized === '进行中') return 'bg-blue-100 text-blue-800';
    if (normalized === '已完成') return 'bg-green-100 text-green-800';
    if (normalized === '阻塞') return 'bg-orange-100 text-orange-800';
    return 'bg-gray-100 text-gray-800';
  };
  
  const overdue = isMilestoneOverdue(milestone);

  return (
    <Link href={`/orders/${order?.id}?tab=progress#milestone-${milestone.id}`}>
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <h3 className="font-semibold text-lg">{milestone.name}</h3>
          {milestone.is_critical && (
            <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
              关键
            </span>
          )}
        </div>
        
        {order && (
          <p className="text-sm text-gray-600 mb-2">
            订单: {order.order_no}
            {(order as any).internal_order_no && (
              <span className="ml-2 text-gray-400">({(order as any).internal_order_no})</span>
            )}
          </p>
        )}
        
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-2 py-1 rounded ${getStatusColor(milestone.status)}`}>
            {milestone.status}
          </span>
        </div>
        
        <div className="text-sm text-gray-600 space-y-1">
          {milestone.due_at && <p>到期: {formatDate(milestone.due_at)}</p>}
          <p>负责人: {milestone.owner_role}</p>
          {isBlockedStatus(milestone.status) && milestone.notes && (
            <p className="text-orange-600">
              卡住原因: {extractBlockedReason(milestone.notes) || milestone.notes}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
