'use client';

import { useState, useEffect, useRef } from 'react';
import { getFactories, type Factory } from '@/app/actions/factories';

/**
 * 多工厂选择器：用于一个订单分多个厂区生产的场景
 *
 * 写入两个 hidden 字段：
 *   - factory_ids:    JSON 字符串数组（如 '["uuid1","uuid2"]'）
 *   - factory_names:  JSON 字符串数组（如 '["A厂","B厂"]'）
 *
 * 注意：主工厂仍由 <FactorySelect /> 维护（factory_id / factory_name），
 * 多工厂作为补充信息存储，便于产能 / 验货分组。
 */
export function MultiFactorySelect() {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [selected, setSelected] = useState<Factory[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getFactories().then(({ data }) => setFactories(data || []));
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

  const filtered = factories
    .filter(f => f.factory_name.toLowerCase().includes(query.toLowerCase()))
    .filter(f => !selected.some(s => s.id === f.id));

  function toggle(f: Factory) {
    setSelected(prev =>
      prev.some(s => s.id === f.id) ? prev.filter(s => s.id !== f.id) : [...prev, f]
    );
    setQuery('');
  }

  function remove(id: string) {
    setSelected(prev => prev.filter(s => s.id !== id));
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        额外生产厂区（可多选）
      </label>

      {/* 已选 chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map(f => (
            <span key={f.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-100 text-indigo-700 border border-indigo-200">
              {f.factory_name}
              <button type="button" onClick={() => remove(f.id)}
                className="text-indigo-500 hover:text-indigo-900 ml-0.5">×</button>
            </span>
          ))}
        </div>
      )}

      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="搜索并勾选额外厂区（分厂区生产时填写）"
        autoComplete="off"
        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />

      <input type="hidden" name="factory_ids" value={JSON.stringify(selected.map(s => s.id))} />
      <input type="hidden" name="factory_names" value={JSON.stringify(selected.map(s => s.factory_name))} />

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-400">
              {query ? '未找到匹配工厂' : '已无更多工厂可选'}
            </div>
          )}
          {filtered.map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => toggle(f)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 text-gray-700"
            >
              + {f.factory_name}
            </button>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-1">
        留空表示单厂生产；勾选后将记录为「{selected.length}个额外厂区」用于产能分组
      </p>
    </div>
  );
}
