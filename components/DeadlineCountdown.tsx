'use client';

import { useState, useEffect } from 'react';

interface Props {
  targetDate: string;
  label: string;
  /** 业务已确认「待客户指令出运」— 逾期仍用蓝标区分真实延误 */
  customerHoldVisual?: boolean;
}

export function DeadlineCountdown({ targetDate, label, customerHoldVisual }: Props) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000); // 每分钟刷新
    return () => clearInterval(timer);
  }, []);

  const target = new Date(targetDate);
  const diffMs = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (isNaN(diffDays)) return null;

  const isOverdue = diffDays < 0;
  const isUrgent = diffDays >= 0 && diffDays <= 7;
  const isWarning = diffDays > 7 && diffDays <= 14;

  const color =
    isOverdue && customerHoldVisual
      ? 'text-blue-700 bg-blue-50 border-blue-200'
      : isOverdue
        ? 'text-red-600 bg-red-50 border-red-200'
        : isUrgent
          ? 'text-orange-600 bg-orange-50 border-orange-200'
          : isWarning
            ? 'text-amber-600 bg-amber-50 border-amber-200'
            : 'text-green-600 bg-green-50 border-green-200';

  const text = isOverdue && customerHoldVisual
    ? `待客户指令 · ${Math.abs(diffDays)} 天`
    : isOverdue
    ? `已超 ${Math.abs(diffDays)} 天`
    : diffDays === 0
    ? '今天到期'
    : `剩余 ${diffDays} 天`;

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${color}`}>
      <span>{label}</span>
      <span className="font-bold">{text}</span>
    </div>
  );
}
