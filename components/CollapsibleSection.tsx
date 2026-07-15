'use client';

/** 可折叠区块——生产中心各大块(全部在产/排产工作台/甘特图等)可收起,页面不再一屏塞满。 */

import { useState, type ReactNode } from 'react';

export function CollapsibleSection({
  title, subtitle, defaultOpen = true, right, children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/40 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-gray-100/60 transition">
        <span className={`text-gray-400 text-xs transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-sm font-semibold text-gray-800">{title}</span>
        {subtitle && <span className="text-xs text-gray-400">{subtitle}</span>}
        <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>{right}</span>
        <span className="text-xs text-indigo-500">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
