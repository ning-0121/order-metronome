'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChevronRightIcon } from './icons';

export type QimoQuickEntry = { title: string; href: string; icon: ReactNode; subtitle?: string; ariaLabel?: string };

export function QimoQuickEntryItem({ entry }: { entry: QimoQuickEntry }) {
  const router = useRouter();
  return (
    <Link
      href={entry.href}
      aria-label={entry.ariaLabel || entry.title}
      onKeyDown={(event) => {
        if (event.key === ' ') { event.preventDefault(); router.push(entry.href); }
      }}
      className="group flex h-14 min-w-0 items-center gap-2.5 rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface)] px-3 text-left transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)] focus-visible:ring-offset-2"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-indigo-600">{entry.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--qimo-text)] group-hover:text-indigo-700">{entry.title}</span>
        {entry.subtitle && <span className="block truncate text-[11px] text-[var(--qimo-text-secondary)]">{entry.subtitle}</span>}
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-600" />
    </Link>
  );
}

export function QimoQuickEntryRow({ entries, title = '快捷入口' }: { entries: QimoQuickEntry[]; title?: string }) {
  return <section aria-labelledby="qimo-quick-entry-title"><h2 id="qimo-quick-entry-title" className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2><div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">{entries.map((entry) => <QimoQuickEntryItem key={entry.href} entry={entry} />)}</div></section>;
}

export function QimoKpiGrid({ children }: { children: ReactNode }) { return <section aria-label="生产 KPI" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{children}</section>; }

export function QimoKpiCard({ href, label, value, icon, tone = 'text-slate-700' }: { href: string; label: string; value: number; icon: ReactNode; tone?: string }) {
  return <Link href={href} className="rounded-xl border border-[var(--qimo-border)] bg-white px-3 py-2.5 hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"><div className="flex items-center justify-between"><span>{icon}</span><span className={`text-xl font-bold tabular-nums ${tone}`}>{value}</span></div><div className="mt-1 truncate text-xs text-slate-600">{label}</div></Link>;
}

export function QimoCommandGrid({ children }: { children: ReactNode }) { return <div className="grid gap-3 lg:grid-cols-3">{children}</div>; }

export function QimoEmptyState({ children }: { children: ReactNode }) { return <div className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-400">{children}</div>; }
