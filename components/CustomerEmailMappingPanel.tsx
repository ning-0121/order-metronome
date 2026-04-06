'use client';

import { useState, useEffect } from 'react';
import {
  getCustomerEmailDomains,
  addEmailDomainMapping,
  removeEmailDomainMapping,
  type EmailDomainMapping,
} from '@/app/actions/customer-email-mapping';

interface Props {
  customerName: string;
}

export function CustomerEmailMappingPanel({ customerName }: Props) {
  const [mappings, setMappings] = useState<EmailDomainMapping[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [domain, setDomain] = useState('');
  const [sampleEmail, setSampleEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadMappings();
  }, [customerName]);

  async function loadMappings() {
    setLoading(true);
    const { data } = await getCustomerEmailDomains(customerName);
    setMappings(data || []);
    setLoading(false);
  }

  async function handleAdd() {
    if (!domain.trim()) return;
    setSaving(true);
    setError('');
    const { error: err } = await addEmailDomainMapping(customerName, domain, sampleEmail || undefined);
    if (err) {
      setError(err);
    } else {
      setDomain('');
      setSampleEmail('');
      setShowAdd(false);
      await loadMappings();
    }
    setSaving(false);
  }

  async function handleRemove(id: string) {
    const { error: err } = await removeEmailDomainMapping(id);
    if (!err) {
      setMappings(prev => prev.filter(m => m.id !== id));
    }
  }

  if (loading) return null;

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">📧 邮箱绑定</span>
        {mappings.map(m => (
          <span key={m.id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
            @{m.email_domain}
            <button
              onClick={() => handleRemove(m.id)}
              className="text-indigo-400 hover:text-red-500 ml-0.5"
              title="移除"
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {showAdd ? '取消' : '+ 添加域名'}
        </button>
      </div>

      {showAdd && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-400">@</span>
          <input
            type="text"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            placeholder="example.com"
            className="text-xs border border-gray-200 rounded px-2 py-1 w-36 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <input
            type="text"
            value={sampleEmail}
            onChange={e => setSampleEmail(e.target.value)}
            placeholder="联系人邮箱（选填）"
            className="text-xs border border-gray-200 rounded px-2 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !domain.trim()}
            className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '...' : '确定'}
          </button>
          {error && <span className="text-xs text-red-500">{error}</span>}
        </div>
      )}
    </div>
  );
}
