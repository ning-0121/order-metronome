'use client';

import Link from 'next/link';

interface Card {
  id: string;
  name: string;
  desc: string;
  icon: string;
  kind: 'internal' | 'external';
  href: string;
}

export function HubClient({ cards, userName, roles }: { cards: Card[]; userName: string; roles: string[] }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white text-2xl">
          🧭
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">QIMO OS 统一入口</h1>
          <p className="text-sm text-gray-500">
            {userName} · 可进入 {cards.length} 个系统
            {roles.length > 0 && <span className="text-gray-400"> · {roles.join(' / ')}</span>}
          </p>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          当前角色暂无可进入的系统，请联系管理员配置角色。
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((c) => {
            const inner = (
              <>
                <div className="text-3xl mb-3">{c.icon}</div>
                <h3 className="font-semibold text-gray-900 text-sm mb-1 flex items-center gap-1.5">
                  {c.name}
                  {c.kind === 'external' && (
                    <span className="text-[10px] font-normal text-indigo-400 border border-indigo-200 rounded px-1">跳转</span>
                  )}
                </h3>
                <p className="text-xs text-gray-500 leading-relaxed">{c.desc}</p>
              </>
            );
            const cls =
              'block rounded-xl border border-gray-200 bg-white p-5 hover:border-indigo-300 hover:shadow-sm transition-all';
            // internal：应用内导航；external：整页跳转触发 /api/os/handoff（服务端铸 token/302）
            return c.kind === 'internal' ? (
              <Link key={c.id} href={c.href} className={cls}>{inner}</Link>
            ) : (
              <a key={c.id} href={c.href} className={cls}>{inner}</a>
            );
          })}
        </div>
      )}

      <p className="mt-8 text-xs text-gray-400">
        统一入口 Phase A：一次登录 · 按角色分权显示 · 外部系统受控跳转（目标接入后免二次登录）。
      </p>
    </div>
  );
}
