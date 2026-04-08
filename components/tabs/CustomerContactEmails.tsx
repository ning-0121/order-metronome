'use client';

/**
 * 客户联系邮箱管理组件
 *
 * 业务可手动添加 / 删除客户的邮箱地址
 * email-scan 在识别 from_email 时会优先按这个列表精确匹配
 */

import { useEffect, useState } from 'react';
import {
  getCustomerContactEmails,
  addCustomerContactEmail,
  removeCustomerContactEmail,
} from '@/app/actions/customer-contact-emails';

interface Props {
  customerName: string;
}

export function CustomerContactEmails({ customerName }: Props) {
  const [emails, setEmails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const res = await getCustomerContactEmails(customerName);
    if (res.error) setError(res.error);
    else setEmails(res.data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [customerName]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd() {
    const trimmed = newEmail.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    const res = await addCustomerContactEmail(customerName, trimmed);
    if (res.error) {
      setError(res.error);
    } else {
      setEmails(res.data || []);
      setNewEmail('');
    }
    setAdding(false);
  }

  async function handleRemove(email: string) {
    if (!confirm(`确定移除 ${email}？AI 不再优先把这个地址识别为 ${customerName}`)) return;
    const res = await removeCustomerContactEmail(customerName, email);
    if (res.error) alert(res.error);
    else setEmails(res.data || []);
  }

  if (!customerName) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-gray-400 text-sm">
        订单未关联客户，无法管理联系邮箱
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">
          👥 {customerName} 的联系邮箱
        </h3>
        <p className="text-xs text-gray-500 mt-1">
          业务手动添加客户邮箱后，邮件 cron 在识别来件时会优先精确匹配，
          帮 AI 跳过域名/模糊匹配，提高客户识别准确率。
        </p>
      </div>

      {/* 添加输入 */}
      <div className="flex gap-2 mb-4">
        <input
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="如 buyer@example.com"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newEmail.trim()}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          {adding ? '添加中...' : '添加'}
        </button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
          ⚠️ {error}
        </div>
      )}

      {/* 邮箱列表 */}
      {loading ? (
        <p className="text-xs text-gray-400">加载中...</p>
      ) : emails.length === 0 ? (
        <div className="text-center py-6 text-sm text-gray-400">
          暂无补充邮箱<br />
          <span className="text-xs">添加后，AI 在识别来件时会优先匹配这里的地址</span>
        </div>
      ) : (
        <div className="space-y-2">
          {emails.map(email => (
            <div
              key={email}
              className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 border border-gray-200"
            >
              <span className="text-sm text-gray-800 font-mono">{email}</span>
              <button
                onClick={() => handleRemove(email)}
                className="text-xs text-red-500 hover:text-red-700"
                title="移除"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-400">
        💡 提示：如果一个客户有多个采购员（不同邮箱），把每个邮箱都加进来。
        AI 会自动把他们都识别为「{customerName}」。
      </div>
    </div>
  );
}
