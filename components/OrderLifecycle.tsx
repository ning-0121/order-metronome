'use client';

import { OrderLifecycleStatus } from '@/lib/domain/types';
import Link from 'next/link';

interface OrderLifecycleProps {
  status: OrderLifecycleStatus;
  orderId: string;
}

const lifecycleSteps: Array<{ status: OrderLifecycleStatus; label: string }> = [
  { status: '草稿', label: '草稿' },
  { status: '已生效', label: '已生效' },
  { status: '执行中', label: '执行中' },
  { status: '已完成', label: '已完成' },
  { status: '已取消', label: '已取消' },
  { status: '待复盘', label: '待复盘' },
  { status: '已复盘', label: '已复盘' },
];

export function OrderLifecycle({ status, orderId }: OrderLifecycleProps) {
  const currentIndex = lifecycleSteps.findIndex(s => s.status === status);
  
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {lifecycleSteps.map((step, index) => {
          const isActive = index === currentIndex;
          const isPast = index < currentIndex;
          const isFuture = index > currentIndex;
          
          return (
            <div key={step.status} className="flex items-center gap-2 flex-shrink-0">
              <div
                className={`
                  px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive 
                    ? 'bg-blue-600 text-white' 
                    : isPast 
                    ? 'bg-gray-200 text-gray-700' 
                    : 'bg-gray-100 text-gray-400'
                  }
                `}
              >
                {step.label}
              </div>
              {index < lifecycleSteps.length - 1 && (
                <div className={`w-8 h-0.5 ${isPast ? 'bg-gray-400' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
      </div>
      
      {status === '待复盘' && (
        <div className="mt-4 p-4 bg-purple-50 border border-purple-200 rounded-lg">
          <p className="text-purple-800 font-medium mb-2">
            ⚠️ 该订单已终结，必须完成复盘才算闭环
          </p>
          <Link
            href={`/orders/${orderId}/retrospective`}
            className="inline-block px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            去复盘（必做）
          </Link>
        </div>
      )}
    </div>
  );
}
