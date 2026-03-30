'use client';

import { useState, useEffect, useRef } from 'react';
import { getFactories, createFactory, type Factory } from '@/app/actions/factories';

export function FactorySelect() {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [selected, setSelected] = useState<Factory | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getFactories().then(({ data }) => {
      setFactories(data || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = factories.filter(f =>
    f.factory_name.toLowerCase().includes(query.toLowerCase())
  );

  function handleSelect(f: Factory) {
    setSelected(f);
    setQuery(f.factory_name);
    setOpen(false);
  }

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError('');

    const { data, error } = await createFactory(trimmed);
    if (error) {
      setCreateError(error);
      setCreating(false);
      return;
    }
    if (data) {
      setFactories(prev => [...prev, data].sort((a, b) => a.factory_name.localeCompare(b.factory_name)));
      handleSelect(data);
      setShowCreate(false);
      setNewName('');
    }
    setCreating(false);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        工厂
      </label>

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
          placeholder={loading ? '加载中...' : '搜索或选择工厂'}
          autoComplete="off"
          className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 pr-8"
        />
        {selected && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-green-500 text-sm">✓</span>
        )}
      </div>

      <input type="hidden" name="factory_id" value={selected?.id || ''} />
      <input type="hidden" name="factory_name" value={selected?.factory_name || ''} />

      {open && !showCreate && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
          {filtered.length === 0 && query && (
            <div className="px-3 py-2 text-sm text-gray-400">
              未找到匹配工厂
            </div>
          )}
          {filtered.map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => handleSelect(f)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition-colors ${
                selected?.id === f.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700'
              }`}
            >
              {f.factory_name}
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
            <span>＋</span> 新建工厂{query ? `「${query}」` : ''}
          </button>
        </div>
      )}

      {showCreate && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg p-4">
          <p className="text-sm font-semibold text-gray-900 mb-3">新建工厂</p>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="工厂名称（必填）"
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
