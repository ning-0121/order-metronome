'use client';

/**
 * 邮件中心 Tab — 合并原 EmailTab + EmailDiffsTab + 新的客户邮箱补充
 *
 * 三个子区：
 *  1. 邮件往来（EmailTab 内容）— 本订单 + 客户全部邮件
 *  2. 邮件差异（EmailDiffsTab 内容）— 邮件 vs 订单数据差异
 *  3. 联系邮箱（NEW）— 业务手动补充客户邮箱，让 email-scan 精确识别
 */

import { useState } from 'react';
import { EmailTab } from './EmailTab';
import { EmailDiffsTab } from './EmailDiffsTab';
import { CustomerContactEmails } from './CustomerContactEmails';

interface Props {
  orderId: string;
  customerName: string;
  orderNo: string;
}

type SubTab = 'emails' | 'diffs' | 'contacts';

const SUB_TABS: Array<{ key: SubTab; label: string; icon: string }> = [
  { key: 'emails', label: '邮件往来', icon: '📧' },
  { key: 'diffs', label: '邮件 vs 订单差异', icon: '🔍' },
  { key: 'contacts', label: '客户联系邮箱', icon: '👥' },
];

export function EmailCenterTab({ orderId, customerName, orderNo }: Props) {
  const [active, setActive] = useState<SubTab>('emails');

  return (
    <div>
      {/* 标题 + 子 Tab 切换 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">📬 邮件中心</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              本订单 / 客户的邮件往来、AI 差异检测、联系邮箱管理
            </p>
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {SUB_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setActive(t.key)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  active === t.key
                    ? 'bg-white text-indigo-700 shadow-sm font-medium'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span className="mr-1">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 子 Tab 内容 */}
      {active === 'emails' && (
        <EmailTab orderId={orderId} customerName={customerName} orderNo={orderNo} />
      )}
      {active === 'diffs' && (
        <EmailDiffsTab orderId={orderId} />
      )}
      {active === 'contacts' && (
        <CustomerContactEmails customerName={customerName} />
      )}
    </div>
  );
}
