'use client';

import { useState, useEffect, useRef } from 'react';
import { getCustomers, createCustomer, type Customer } from '@/app/actions/customers';

export function CustomerSelect() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // 新建客户弹窗
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCustomers().then(({ data }) => {
      setCustomers(data || []);
      setLoading(false);
    });
  }, []);

  // 点击外部关闭下拉
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = customers.filter(c =>
    c.customer_name.toLowerCase().includes(query.toLowerCase())
  );

  function handleSelect(c: Customer) {
    setSelected(c);
    setQuery(c.customer_name);
    setOpen(false);
  }

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError('');

    const { data, error } = await createCustomer(trimmed);
    if (error) {
      setCreateError(error);
      setCreating(false);
      return;
    }
    if (data) {
      setCustomers(prev => [...prev, data].sort((a, b) => a.customer_name.localeCompare(b.customer_name)));
      handleSelect(data);
      setShowCreate(false);
      setNewName('');
    }
    setCreating(false);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        客户名称 <span className="text-red-500">*</span>
      </label>

      {/* 搜索输入框 */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setSelected(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={loading ? '加载中...' : '搜索或选择客户'}
          autoComplete="off"
          className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 pr-8"
        />
        {selected && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-green-500 text-sm">✓</span>
        )}
      </div>

      {/* Hidden inputs for form submission */}
      <input type="hidden" name="customer_id" value={selected?.id || ''} />
      <input type="hidden" name="customer_name" value={selected?.customer_name || ''} />

      {/* 下拉列表 */}
      {open && !showCreate && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
          {filtered.length === 0 && query && (
            <div className="px-3 py-2 text-sm text-gray-400">
              未找到匹配客户
            </div>
          )}
          {filtered.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleSelect(c)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition-colors ${
                selected?.id === c.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700'
              }`}
            >
              {c.customer_name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setShowCreate(true);
              setNewName(query);
              setCreateError('');
            }}
            className="w-full text-left px-3 py-2 text-sm text-indigo-600 font-medium hover:bg-indigo-50 border-t border-gray-100 flex items-center gap-1.5"
          >
            <span>＋</span> 新建客户{query ? `「${query}」` : ''}
          </button>
        </div>
      )}

      {/* 新建客户弹窗 */}
      {showCreate && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg p-4">
          <p className="text-sm font-semibold text-gray-900 mb-3">新建客户</p>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="客户名称（必填）"
            autoFocus
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-2"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
          />
          {createError && <p className="text-xs text-red-600 mb-2">{createError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="flex-1 rounded-lg py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {creating ? '创建中...' : '创建并选中'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
