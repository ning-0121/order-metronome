import Link from 'next/link';
import type { SVGProps } from 'react';
import { QimoApprovalCard, QimoCollapsibleSection, QimoCommandGrid, QimoCommandPanel, QimoEmptyState, QimoKpiCard, QimoKpiGrid, QimoPage, QimoPageHeader, QimoQuickEntryRow, QimoRiskCard, type QimoQuickEntry } from '@/components/qimo-v2/QimoDashboard';
import type { OrderCenterDashboard, OrderCenterCommandItem, OrderCenterStage } from '@/lib/orders/order-center-dashboard';

function OrderSparkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 20h16" />
      <path d="M7 16v-6" />
      <path d="M12 16V8" />
      <path d="M17 16v-3" />
      <path d="M6 9h6l2-3h4" />
    </svg>
  );
}

function WorkbenchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h10M7 13h6M7 17h4" />
    </svg>
  );
}

function DocumentWarningIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M7 3h6l4 4v14H7z" />
      <path d="M13 3v5h5" />
      <path d="M11 11v4m0 2h.01" />
    </svg>
  );
}

function RiskShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z" />
      <path d="M12 8v5m0 3h.01" />
    </svg>
  );
}

function getStageTone(stage: OrderCenterStage): string {
  switch (stage.tone) {
    case 'success':
      return 'text-emerald-600';
    case 'warning':
      return 'text-amber-600';
    case 'risk':
      return 'text-rose-600';
    case 'info':
      return 'text-indigo-600';
    default:
      return 'text-slate-700';
  }
}

function StageCard({ stage }: { stage: OrderCenterStage }) {
  return (
    <Link
      href={stage.href}
      className="rounded-lg border border-[var(--qimo-border)] bg-white px-4 py-3 shadow-[var(--qimo-shadow-subtle)] transition-all hover:-translate-y-[1px] hover:border-indigo-300 hover:shadow-[var(--qimo-shadow-floating)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)] focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--qimo-text-primary)]">{stage.label}</div>
          <div className="mt-1 text-xs text-[var(--qimo-text-secondary)]">{stage.percentage}% · 点击查看</div>
        </div>
        <div className={`text-2xl font-bold tabular-nums ${getStageTone(stage)}`}>{stage.count}</div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-[var(--qimo-primary)]"
          style={{ width: `${Math.max(4, Math.min(100, stage.percentage || 0))}%` }}
        />
      </div>
    </Link>
  );
}

function CommandPanelSection({
  title,
  subtitle,
  href,
  items,
  emptyLabel,
}: {
  title: string;
  subtitle?: string;
  href: string;
  items: OrderCenterCommandItem[];
  emptyLabel: string;
}) {
  return (
    <QimoCommandPanel title={title} subtitle={subtitle} count={items.length} href={href}>
      <div className="space-y-2">
        {items.length > 0 ? (
          items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="block rounded-lg border border-[var(--qimo-border)] bg-[var(--qimo-surface-muted)] px-3 py-2 transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)] focus-visible:ring-offset-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[var(--qimo-text-primary)]">{item.title}</div>
                  {item.description && <div className="mt-0.5 truncate text-xs text-[var(--qimo-text-secondary)]">{item.description}</div>}
                </div>
                <div className="shrink-0 text-xs text-[var(--qimo-text-secondary)]">
                  {typeof item.count === 'number' ? <span className="rounded-full bg-white px-2 py-0.5 font-semibold text-[var(--qimo-primary)]">{item.count}</span> : null}
                </div>
              </div>
            </Link>
          ))
        ) : (
          <QimoEmptyState>{emptyLabel}</QimoEmptyState>
        )}
      </div>
    </QimoCommandPanel>
  );
}

export function OrderCenterDashboardShell({
  dashboard,
  searchParams,
}: {
  dashboard: OrderCenterDashboard;
  searchParams: { q?: string; phase?: string; status?: string };
}) {
  const quickEntries: QimoQuickEntry[] = [
    { title: '新建订单', href: '/orders/new', icon: <OrderSparkIcon className="h-4 w-4" /> },
    { title: '订单执行工作台', href: '/orders?detail=1', icon: <WorkbenchIcon className="h-4 w-4" /> },
    { title: '待补资料', href: '/my-today', icon: <DocumentWarningIcon className="h-4 w-4" /> },
    { title: '风险订单', href: '/risk-orders/overdue', icon: <RiskShieldIcon className="h-4 w-4" /> },
  ];

  const filteredDetailHref = (() => {
    const params = new URLSearchParams();
    params.set('detail', '1');
    if (searchParams.q) params.set('q', searchParams.q);
    if (searchParams.phase) params.set('phase', searchParams.phase);
    if (searchParams.status) params.set('status', searchParams.status);
    const query = params.toString();
    return `/orders${query ? `?${query}` : ''}`;
  })();

  return (
    <QimoPage>
      <QimoPageHeader
        title="订单中心"
        subtitle="订单执行总览与任务协同执行中心"
        searchSlot={(
          <form action="/orders" method="get" className="flex w-full items-center gap-2">
            <input type="hidden" name="detail" value="1" />
            <input
              name="q"
              defaultValue={searchParams.q || ''}
              placeholder="订单、PO、款号、客户"
              className="h-10 w-full min-w-0 rounded-lg border border-[var(--qimo-border)] bg-white px-3 text-sm text-[var(--qimo-text-primary)] placeholder:text-[var(--qimo-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--qimo-focus)]"
            />
            <button
              type="submit"
              className="h-10 rounded-lg bg-[var(--qimo-primary)] px-4 text-sm font-medium text-white hover:bg-[var(--qimo-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
            >
              搜索
            </button>
          </form>
        )}
        actions={(
          <>
            <Link
              href={filteredDetailHref}
              className="inline-flex h-10 items-center rounded-lg border border-[var(--qimo-border)] bg-white px-3 text-sm font-medium text-[var(--qimo-text-primary)] transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
            >
              查看完整工作台
            </Link>
            <Link
              href="/orders"
              className="inline-flex h-10 items-center rounded-lg border border-[var(--qimo-border)] bg-white px-3 text-sm font-medium text-[var(--qimo-text-primary)] transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
            >
              刷新
            </Link>
          </>
        )}
      />

      <section>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--qimo-text-muted)]">快捷入口</h2>
            <p className="mt-1 text-xs text-[var(--qimo-text-secondary)]">进入新建、工作台、补资料和风险处理的真实页面</p>
          </div>
          <div className="text-xs text-[var(--qimo-text-muted)]">QIMO 生产级模块中心</div>
        </div>
        <QimoQuickEntryRow entries={quickEntries} />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--qimo-text-primary)]">订单 KPI</h2>
          <p className="mt-1 text-xs text-[var(--qimo-text-muted)]">来源于现有订单、里程碑、延期申请与待审批真相</p>
        </div>
        <QimoKpiGrid>
          {dashboard.kpis.map((item) => (
            <QimoKpiCard key={item.key} href={item.href} label={item.label} value={item.count} icon={<OrderSparkIcon className="h-4 w-4 text-[var(--qimo-primary)]" />} />
          ))}
        </QimoKpiGrid>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--qimo-text-primary)]">订单执行阶段概览</h2>
          <p className="mt-1 text-xs text-[var(--qimo-text-muted)]">点击阶段进入对应的完整工作台视图</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          {dashboard.stages.map((stage) => (
            <StageCard key={stage.key} stage={stage} />
          ))}
        </div>
      </section>

      <QimoCommandGrid>
        <CommandPanelSection
          title="今日待办事项"
          subtitle="当前用户的订单相关今日任务"
          href="/my-today"
          items={dashboard.todayTasks}
          emptyLabel="今日没有新的订单待办"
        />
        <QimoApprovalCard
          title="协作 / 审批提示"
          subtitle="延期、改单、价格、付款冻结等审批入口"
          count={dashboard.approvals.length}
          href="/admin/pending-approvals"
          items={dashboard.approvals.map((item) => ({
            id: item.key,
            label: item.title,
            detail: item.description,
            meta: item.severity ? item.severity : undefined,
            href: item.href,
            tone: item.severity === 'critical' ? 'risk' : item.severity === 'high' ? 'warning' : 'info',
          }))}
        />
        <QimoRiskCard
          title="风险干预预警"
          subtitle="逾期、延期与异常风险订单"
          count={dashboard.risks.length}
          href="/risk-orders/overdue"
          items={dashboard.risks.map((item) => ({
            id: item.key,
            label: item.title,
            detail: item.description,
            meta: typeof item.count === 'number' ? `${item.count} 天` : item.severity || undefined,
            href: item.href,
            tone: item.severity === 'critical' ? 'risk' : item.severity === 'high' ? 'warning' : 'info',
          }))}
        />
      </QimoCommandGrid>

      <QimoCollapsibleSection
        title={`详细订单列表（${dashboard.detailedOrderCount}）`}
        subtitle="默认折叠；点击进入完整工作台后加载当前页原有的表格、筛选和行操作"
        defaultOpen={false}
      >
        <div className="space-y-3">
          <QimoEmptyState>详细列表已折叠，保持首页轻量。进入完整工作台后仍使用现有订单表格、权限与动作。</QimoEmptyState>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={filteredDetailHref}
              className="inline-flex h-10 items-center rounded-lg bg-[var(--qimo-primary)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--qimo-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
            >
              进入完整工作台
            </Link>
            <Link
              href="/orders?detail=1"
              className="inline-flex h-10 items-center rounded-lg border border-[var(--qimo-border)] bg-white px-4 text-sm font-medium text-[var(--qimo-text-primary)] transition-colors hover:border-indigo-300 hover:bg-[var(--qimo-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qimo-focus)]"
            >
              仅展开当前列表
            </Link>
          </div>
        </div>
      </QimoCollapsibleSection>
    </QimoPage>
  );
}
