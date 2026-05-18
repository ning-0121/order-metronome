'use client';

/**
 * 客户信用风险 banner —— 新订单创建时根据客户分级显示
 *
 * 触发：customer_name 选择 / 输入时实时查询
 * 行为：根据 CreditTier 显示对应颜色和文案，提醒业务采用合适付款条款
 */

import { useEffect, useState } from 'react';
import { getCustomerCredit, type CustomerCreditInfo } from '@/app/actions/customer-credit';

interface Props {
  customerName: string;
}

const COLOR_CLASSES: Record<string, { bg: string; border: string; text: string; titleText: string }> = {
  red:   { bg: 'bg-red-50',    border: 'border-red-300',    text: 'text-red-700',    titleText: 'text-red-900' },
  amber: { bg: 'bg-amber-50',  border: 'border-amber-300',  text: 'text-amber-700',  titleText: 'text-amber-900' },
  green: { bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  titleText: 'text-green-900' },
  blue:  { bg: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700',   titleText: 'text-blue-900' },
};

export function CustomerCreditBanner({ customerName }: Props) {
  const [info, setInfo] = useState<CustomerCreditInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = customerName?.trim();
    if (!trimmed || trimmed.length < 2) {
      setInfo(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    // Debounce: 等用户停止输入 500ms 再查
    const t = setTimeout(async () => {
      try {
        const res = await getCustomerCredit(trimmed);
        if (!cancelled && res.data) setInfo(res.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [customerName]);

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
        正在评估客户信用…
      </div>
    );
  }
  if (!info) return null;

  const c = COLOR_CLASSES[info.color] || COLOR_CLASSES.blue;

  return (
    <div className={`rounded-lg border ${c.border} ${c.bg} p-3 space-y-1.5`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className={`text-sm font-semibold ${c.titleText}`}>
          {info.label} · {info.customerName}
        </p>
        <div className="text-[11px] text-gray-600 flex gap-3">
          <span>历史 <strong>{info.totalOrderCount}</strong> 单</span>
          {info.overduePayments > 0 && (
            <span className="text-red-700">延付 <strong>{info.overduePayments}</strong> 次</span>
          )}
          {info.riskScore > 0 && (
            <span>风险评分 {info.riskScore}</span>
          )}
        </div>
      </div>

      <p className={`text-xs ${c.text}`}>{info.risk}</p>

      <div className={`text-xs ${c.text} pt-1 border-t border-current/10`}>
        <strong>推荐付款条款：</strong>{info.recommendedTerms}
      </div>

      {info.requiresAdminApproval && (
        <div className="text-[11px] text-red-600 font-medium pt-1">
          ⚠️ 此客户信用级别需要 admin 审批方可正常推进订单
        </div>
      )}
    </div>
  );
}
