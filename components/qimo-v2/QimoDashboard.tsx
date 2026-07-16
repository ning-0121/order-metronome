'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ChevronRightIcon } from './icons';

type Tone = 'neutral' | 'success' | 'warning' | 'risk' | 'critical' | 'info' | 'order' | 'procurement' | 'production' | 'logistics' | 'finance';

const toneClass: Record<Tone, string> = {
  neutral: 'qimo-tone-neutral',
  success: 'qimo-tone-success',
  warning: 'qimo-tone-warning',
  risk: 'qimo-tone-risk',
  critical: 'qimo-tone-critical',
  info: 'qimo-tone-info',
  order: 'qimo-tone-order',
  procurement: 'qimo-tone-procurement',
  production: 'qimo-tone-production',
  logistics: 'qimo-tone-logistics',
  finance: 'qimo-tone-finance',
};

const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export function QimoPage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('qimo-page', className)}>{children}</div>;
}

export function QimoPageHeader({
  title,
  subtitle,
  searchSlot,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  searchSlot?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('qimo-page-header', className)}>
      <div>
        <h1 className="qimo-page-title">{title}</h1>
        {subtitle && <p className="qimo-page-subtitle">{subtitle}</p>}
      </div>
      <div className="qimo-page-header__center">{searchSlot}</div>
      <div className="qimo-page-header__actions">{actions}</div>
    </header>
  );
}

export function QimoSection({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('qimo-section', className)}>
      <div className="qimo-section__header">
        <div>
          <h2 className="qimo-section__title">{title}</h2>
          {subtitle && <p className="qimo-section__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="qimo-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function QimoCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('qimo-card', className)}>{children}</div>;
}

export function QimoMetric({
  label,
  value,
  hint,
  delta,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn('qimo-metric', toneClass[tone], className)}>
      <div className="qimo-metric__value">{value}</div>
      <div className="qimo-metric__label">{label}</div>
      {delta && <div className="qimo-metric__delta">{delta}</div>}
      {hint && <div className="qimo-metric__hint">{hint}</div>}
    </div>
  );
}

export type QimoQuickEntry = {
  title: string;
  href: string;
  icon: ReactNode;
  subtitle?: string;
  ariaLabel?: string;
};

export function QimoQuickEntryItem({ entry }: { entry: QimoQuickEntry }) {
  const router = useRouter();
  return (
    <Link
      href={entry.href}
      aria-label={entry.ariaLabel || entry.title}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault();
          router.push(entry.href);
        }
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

export function QimoQuickEntryRow({
  entries,
  title = '快捷入口',
}: {
  entries: QimoQuickEntry[];
  title?: string;
}) {
  return (
    <section aria-labelledby="qimo-quick-entry-title">
      <h2 id="qimo-quick-entry-title" className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {entries.map((entry) => (
          <QimoQuickEntryItem key={entry.href} entry={entry} />
        ))}
      </div>
    </section>
  );
}

export function QimoKpiGrid({ children }: { children: ReactNode }) {
  return <section aria-label="KPI" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{children}</section>;
}

export function QimoKpiCard({
  href,
  label,
  value,
  icon,
  tone = 'text-slate-700',
}: {
  href: string;
  label: string;
  value: number;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-[var(--qimo-border)] bg-white px-3 py-2.5 hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
    >
      <div className="flex items-center justify-between">
        <span>{icon}</span>
        <span className={cn('text-xl font-bold tabular-nums', tone)}>{value}</span>
      </div>
      <div className="mt-1 truncate text-xs text-slate-600">{label}</div>
    </Link>
  );
}

export function QimoCommandGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 lg:grid-cols-3">{children}</div>;
}

export function QimoCommandPanel({
  title,
  subtitle,
  count,
  children,
  href,
  className,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  children: ReactNode;
  href?: string;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-[var(--qimo-border)] bg-white p-4 shadow-sm', className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--qimo-text)]">{title}</h3>
            {typeof count === 'number' && (
              <span className="rounded-full bg-[var(--qimo-primary-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--qimo-primary)]">
                {count}
              </span>
            )}
          </div>
          {subtitle && <p className="mt-1 text-xs text-[var(--qimo-text-secondary)]">{subtitle}</p>}
        </div>
        {href && (
          <Link href={href} className="text-xs font-medium text-[var(--qimo-primary)] hover:underline">
            查看全部
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function QimoCompactTaskRow({
  title,
  detail,
  meta,
  href,
  tone = 'neutral',
}: {
  title: string;
  detail?: string;
  meta?: string;
  href?: string;
  tone?: Tone;
}) {
  const content = (
    <div className={cn('flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors', toneClass[tone])}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-[var(--qimo-text)]">{title}</div>
        {detail && <div className="truncate text-xs text-[var(--qimo-text-secondary)]">{detail}</div>}
      </div>
      {meta && <div className="shrink-0 text-xs text-[var(--qimo-text-secondary)]">{meta}</div>}
    </div>
  );

  return href ? <Link href={href}>{content}</Link> : content;
}

export function QimoEmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-slate-50 px-3 py-6 text-center text-xs text-slate-400">{children}</div>;
}

export function QimoLoadingState({ label = '加载中…' }: { label?: string }) {
  return <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-400">{label}</div>;
}

export function QimoErrorState({ title = '加载失败', detail }: { title?: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-6 text-center">
      <div className="text-sm font-semibold text-rose-700">{title}</div>
      {detail && <div className="mt-1 text-xs text-rose-600">{detail}</div>}
    </div>
  );
}

export function QimoAiToday({
  suggestion,
  reason,
  evidence,
  impact,
  owner,
  confidence,
  className,
}: {
  suggestion: string;
  reason: string;
  evidence?: string;
  impact?: string;
  owner?: string;
  confidence?: number;
  className?: string;
}) {
  const stars = Math.max(0, Math.min(5, confidence ?? 0));
  const starText = '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, Math.max(0, 5 - stars));
  return (
    <section className={cn('qimo-ai-panel rounded-xl border border-[var(--qimo-border)] bg-white p-4 shadow-sm', className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--qimo-text)]">AI Today</h3>
          <div className="mt-1 text-xs tracking-[0.15em] text-amber-500">{starText}</div>
        </div>
      </div>
      <div className="mb-3 text-base font-semibold text-[var(--qimo-text)]">{suggestion}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface-muted)] p-3">
          <div className="text-xs font-semibold text-[var(--qimo-text-secondary)]">原因</div>
          <div className="mt-1 text-sm text-[var(--qimo-text)]">{reason}</div>
        </div>
        {evidence && (
          <div className="rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface-muted)] p-3">
            <div className="text-xs font-semibold text-[var(--qimo-text-secondary)]">证据</div>
            <div className="mt-1 text-sm text-[var(--qimo-text)]">{evidence}</div>
          </div>
        )}
        {impact && (
          <div className="rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface-muted)] p-3">
            <div className="text-xs font-semibold text-[var(--qimo-text-secondary)]">影响</div>
            <div className="mt-1 text-sm text-[var(--qimo-text)]">{impact}</div>
          </div>
        )}
        {owner && (
          <div className="rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface-muted)] p-3">
            <div className="text-xs font-semibold text-[var(--qimo-text-secondary)]">负责人</div>
            <div className="mt-1 text-sm text-[var(--qimo-text)]">{owner}</div>
          </div>
        )}
      </div>
    </section>
  );
}

export function QimoApprovalCard({
  title,
  subtitle,
  count,
  items,
  href,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  items: Array<{ id: string; label: string; detail?: string; meta?: string; href?: string; tone?: Tone }>;
  href?: string;
}) {
  return (
    <QimoCommandPanel title={title} subtitle={subtitle} count={count} href={href}>
      <div className="space-y-2">
        {items.slice(0, 5).map((item) => (
          <QimoCompactTaskRow key={item.id} title={item.label} detail={item.detail} meta={item.meta} href={item.href} tone={item.tone ?? 'warning'} />
        ))}
      </div>
    </QimoCommandPanel>
  );
}

export function QimoRiskCard(props: Parameters<typeof QimoApprovalCard>[0]) {
  return <QimoApprovalCard {...props} />;
}

export function QimoExternalSystemEntry({
  title,
  description,
  icon,
  href,
  className,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  href: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        'group flex h-14 min-w-0 items-center gap-2.5 rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface)] px-3 text-left transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)] focus-visible:ring-offset-2',
        className,
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-indigo-600">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--qimo-text)] group-hover:text-indigo-700">{title}</span>
        {description && <span className="block truncate text-[11px] text-[var(--qimo-text-secondary)]">{description}</span>}
      </span>
      <span className="text-xs text-slate-400">↗</span>
    </a>
  );
}

export function QimoCollapsibleSection({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--qimo-border)] bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-slate-50"
      >
        <span className={cn('text-xs text-slate-400 transition-transform', open && 'rotate-90')}>▶</span>
        <span className="text-sm font-semibold text-[var(--qimo-text)]">{title}</span>
        {subtitle && <span className="text-xs text-[var(--qimo-text-secondary)]">{subtitle}</span>}
        <span className="ml-auto text-xs text-[var(--qimo-primary)]">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

export { toneClass as QimoToneClass };
export { ChevronRightIcon };
export const QimoQuickEntry = QimoQuickEntryItem;
