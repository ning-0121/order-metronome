'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface Dimension {
  name: string;
  count: number;
  label?: string;
}

interface Props {
  currentQuery: string;
  currentStatus: string;
  currentCustomer: string;
  currentFactory: string;
  currentIncoterm: string;
  currentType: string;
  /** 订单列表「客户待运 / 待复盘」筛选 */
  currentShipHold?: string;
  dimensions: {
    customers: Dimension[];
    factories: Dimension[];
    incoterms: Dimension[];
    types: (Dimension & { label: string })[];
    merchandisers?: Dimension[];
    salespeople?: Dimension[];
  };
}

export function OrderSearchBar({
  currentQuery,
  currentStatus,
  currentCustomer,
  currentFactory,
  currentIncoterm,
  currentType,
  currentShipHold,
  dimensions,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState(currentQuery);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function buildUrl(overrides: Record<string, string>) {
    const base: Record<string, string> = { status: currentStatus };
    if (currentQuery && !('q' in overrides)) base.q = currentQuery;
    if (currentCustomer && !('customer' in overrides)) base.customer = currentCustomer;
    if (currentFactory && !('factory' in overrides)) base.factory = currentFactory;
    if (currentIncoterm && !('incoterm' in overrides)) base.incoterm = currentIncoterm;
    if (currentType && !('type' in overrides)) base.type = currentType;
    if (currentShipHold && !('ship_hold' in overrides)) base.ship_hold = currentShipHold;
    const merged = { ...base, ...overrides };
    // Remove empty values
    Object.keys(merged).forEach(k => { if (!merged[k]) delete merged[k]; });
    const qs = new URLSearchParams(merged).toString();
    return `/orders${qs ? '?' + qs : ''}`;
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setShowDropdown(false);
    router.push(buildUrl({ q: query }));
  }

  function handleDimensionClick(dimension: string, value: string) {
    setShowDropdown(false);
    router.push(buildUrl({ [dimension]: value }));
  }

  // 当输入框获得焦点且为空时，显示维度面板
  function handleFocus() {
    setShowDropdown(true);
  }

  // 快速筛选维度
  const dimensionSections = [
    { key: 'customer', label: '按客户', icon: '👤', items: dimensions.customers, active: currentCustomer },
    { key: 'factory', label: '按工厂', icon: '🏭', items: dimensions.factories, active: currentFactory },
    { key: 'incoterm', label: '按贸易条款', icon: '🚢', items: dimensions.incoterms, active: currentIncoterm },
    { key: 'type', label: '按订单类型', icon: '📋', items: dimensions.types.map(t => ({ ...t, name: t.name, displayName: t.label })), active: currentType },
    ...(dimensions.merchandisers?.length ? [{ key: 'merchandiser', label: '按跟单', icon: '👔', items: dimensions.merchandisers, active: '' }] : []),
    ...(dimensions.salespeople?.length ? [{ key: 'sales', label: '按业务', icon: '💼', items: dimensions.salespeople, active: '' }] : []),
  ];

  return (
    <div ref={wrapperRef} className="relative mb-4">
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={handleFocus}
            placeholder="搜索订单号、客户、工厂、PO号、款号..."
            className="w-full rounded-xl border border-gray-200 pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
          />
        </div>
        <button
          type="submit"
          className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 transition-colors"
        >
          搜索
        </button>
      </form>

      {/* 维度快捷筛选面板 */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden">
          {/* 维度 tabs */}
          <div className="flex border-b border-gray-100">
            {dimensionSections.map(sec => (
              <button
                key={sec.key}
                onClick={() => setActiveSection(activeSection === sec.key ? null : sec.key)}
                className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                  activeSection === sec.key
                    ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-600'
                    : sec.active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span className="mr-1">{sec.icon}</span>
                {sec.label}
                {sec.active && <span className="ml-1 text-blue-500">*</span>}
              </button>
            ))}
          </div>

          {/* 展开的维度选项 */}
          {activeSection && (
            <div className="p-3 max-h-64 overflow-y-auto">
              <div className="flex flex-wrap gap-2">
                {dimensionSections.find(s => s.key === activeSection)?.items.map((item: any) => {
                  const isActive = (
                    (activeSection === 'customer' && currentCustomer === item.name) ||
                    (activeSection === 'factory' && currentFactory === item.name) ||
                    (activeSection === 'incoterm' && currentIncoterm === item.name) ||
                    (activeSection === 'type' && currentType === item.name)
                  );
                  return (
                    <button
                      key={item.name}
                      onClick={() => handleDimensionClick(activeSection, isActive ? '' : item.name)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                        isActive
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      <span>{item.displayName || item.name}</span>
                      <span className={`text-xs ${isActive ? 'text-indigo-200' : 'text-gray-400'}`}>({item.count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 没有展开任何维度时的提示 */}
          {!activeSection && (
            <div className="px-4 py-3 text-xs text-gray-400">
              点击上方维度快速筛选，或直接输入关键词搜索
            </div>
          )}
        </div>
      )}
    </div>
  );
}
