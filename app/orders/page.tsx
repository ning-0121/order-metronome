import { getOrders } from '@/app/actions/orders';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import { OrderSearchBar } from '@/components/OrderSearchBar';
import { ExportProductionSheetButton } from '@/components/ExportProductionSheetButton';
import { InlineEditField } from '@/components/InlineEditField';

// 阶段进度计算
const PHASE_KEYS = [
  { label: '启动', keys: ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'] },
  { label: '转化', keys: ['order_docs_bom_complete', 'bulk_materials_confirmed'] },
  { label: '产前样', keys: ['processing_fee_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved', 'factory_confirmed'] },
  { label: '采购生产', keys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'] },
  { label: '过程控制', keys: ['mid_qc_check', 'final_qc_check'] },
  { label: '出货', keys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'] },
  { label: '物流收款', keys: ['booking_done', 'customs_export', 'payment_received'] },
];
import { isDoneStatus, isActiveStatus, isBlockedStatus } from '@/lib/domain/types';
const _isDone = (s: string) => isDoneStatus(s);
const _isActive = (s: string) => isActiveStatus(s);
const _isBlocked = (s: string) => isBlockedStatus(s);

function computePhases(milestones: any[]) {
  return PHASE_KEYS.map(phase => {
    const items = milestones.filter(m => phase.keys.includes(m.step_key));
    const done = items.filter(m => _isDone(m.status)).length;
    const active = items.some(m => _isActive(m.status));
    const blocked = items.some(m => _isBlocked(m.status));
    const total = items.length;
    return { ...phase, done, total, active, blocked, allDone: total > 0 && done === total };
  });
}

// 多维度搜索
function matchOrder(order: any, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  // 支持多关键词（空格分隔，AND 逻辑）
  const keywords = q.split(/\s+/).filter(Boolean);
  return keywords.every(kw => {
    const fields = [
      order.order_no,
      order.customer_name,
      order.factory_name,
      order.po_number,
      order.style_no,
      order.internal_order_no,
      order.incoterm,
      order.order_type,
      order.notes,
    ];
    return fields.some(f => f && String(f).toLowerCase().includes(kw));
  });
}

// 提取搜索维度标签
function getSearchDimensions(orders: any[]): {
  customers: { name: string; count: number }[];
  factories: { name: string; count: number }[];
  incoterms: { name: string; count: number }[];
  types: { name: string; label: string; count: number }[];
  merchandisers: { name: string; count: number }[];
  salespeople: { name: string; count: number }[];
} {
  const customerMap: Record<string, number> = {};
  const factoryMap: Record<string, number> = {};
  const incotermMap: Record<string, number> = {};
  const typeMap: Record<string, number> = {};
  const merchMap: Record<string, number> = {};
  const salesMap: Record<string, number> = {};

  for (const o of orders) {
    if (o.customer_name) customerMap[o.customer_name] = (customerMap[o.customer_name] || 0) + 1;
    if (o.factory_name) factoryMap[o.factory_name] = (factoryMap[o.factory_name] || 0) + 1;
    if (o.incoterm) incotermMap[o.incoterm] = (incotermMap[o.incoterm] || 0) + 1;
    if (o.order_type) typeMap[o.order_type] = (typeMap[o.order_type] || 0) + 1;
    if (o.merchandiser_name) merchMap[o.merchandiser_name] = (merchMap[o.merchandiser_name] || 0) + 1;
    if (o.sales_name) salesMap[o.sales_name] = (salesMap[o.sales_name] || 0) + 1;
  }

  const typeLabels: Record<string, string> = { trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' };

  return {
    customers: Object.entries(customerMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    factories: Object.entries(factoryMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    incoterms: Object.entries(incotermMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    types: Object.entries(typeMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, label: typeLabels[name] || name, count })),
    merchandisers: Object.entries(merchMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    salespeople: Object.entries(salesMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  };
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; customer?: string; factory?: string; incoterm?: string; type?: string; purpose?: string; sort?: string; merchandiser?: string; sales?: string }> }) {
  const params = await searchParams;
  const statusFilter = params?.status || 'active';
  const purposeFilter = params?.purpose || 'production';
  const searchQuery = params?.q || '';
  const customerFilter = params?.customer || '';
  const factoryFilter = params?.factory || '';
  const merchandiserFilter = params?.merchandiser || '';
  const salesFilter = params?.sales || '';
  const incotermFilter = params?.incoterm || '';
  const typeFilter = params?.type || '';
  const sortOrder = (params?.sort || 'factory_asc') as
    | 'factory_asc' | 'factory_desc'
    | 'created_desc' | 'created_asc'
    | 'qty_desc' | 'qty_asc';

  const { data: allOrders, error } = await getOrders();

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-2xl bg-red-50 border border-red-200 p-6 text-center">
          <p className="text-red-600">加载失败: {error}</p>
        </div>
      </div>
    );
  }

  // 按用途分组（订单 vs 样品单）
  const purposeOrders = (allOrders || []).filter((o: any) => {
    const p = (o as any).order_purpose || 'production';
    if (purposeFilter === 'sample') return p === 'sample';
    return p !== 'sample'; // production + inquiry 都算订单
  });

  const totalProduction = (allOrders || []).filter((o: any) => (o.order_purpose || 'production') !== 'sample').length;
  const totalSample = (allOrders || []).filter((o: any) => o.order_purpose === 'sample').length;

  // lifecycle_status 完成/取消集合（统一放这里，后面超期计算也用）
  const DONE_LIFECYCLE = new Set(['completed', 'cancelled', '已完成', '已取消']);

  // 按完成状态分组：milestone 全完成 OR lifecycle_status 已完成/已取消 → 都算完成
  const completedOrders = purposeOrders.filter((o: any) => {
    const ms = o.milestones || [];
    const allMsDone = ms.length > 0 && ms.every((m: any) => _isDone(m.status));
    const lifecycleDone = DONE_LIFECYCLE.has(o.lifecycle_status || '');
    return allMsDone || lifecycleDone;
  });
  const activeOrders = purposeOrders.filter((o: any) => !completedOrders.includes(o));
  const baseOrders = statusFilter === 'completed' ? completedOrders : activeOrders;

  // 应用维度筛选
  let filteredOrders = baseOrders;
  if (customerFilter) filteredOrders = filteredOrders.filter((o: any) => o.customer_name === customerFilter);
  if (factoryFilter) filteredOrders = filteredOrders.filter((o: any) => o.factory_name === factoryFilter);
  if (incotermFilter) filteredOrders = filteredOrders.filter((o: any) => o.incoterm === incotermFilter);
  if (typeFilter) filteredOrders = filteredOrders.filter((o: any) => o.order_type === typeFilter);
  if (merchandiserFilter) filteredOrders = filteredOrders.filter((o: any) => o.merchandiser_name === merchandiserFilter);
  if (salesFilter) filteredOrders = filteredOrders.filter((o: any) => o.sales_name === salesFilter);

  // 应用搜索
  const unsorted = filteredOrders.filter((o: any) => matchOrder(o, searchQuery));

  // 计算"有效出厂日"：优先取 factory_date；如果只有 etd 则倒推 3 天（ETD ≈ factory_date + 2~4）
  const effectiveFactoryDate = (o: any): string | null => {
    if (o.factory_date) return String(o.factory_date).slice(0, 10);
    if (o.etd) {
      const d = new Date(String(o.etd).slice(0, 10) + 'T00:00:00+08:00');
      d.setDate(d.getDate() - 3);
      return d.toISOString().slice(0, 10);
    }
    return null;
  };

  // 排序 — 支持 6 种模式
  const orders = [...unsorted].sort((a: any, b: any) => {
    let cmp = 0;
    switch (sortOrder) {
      case 'factory_asc':
      case 'factory_desc': {
        const aDate = effectiveFactoryDate(a);
        const bDate = effectiveFactoryDate(b);
        if (!aDate && !bDate) cmp = 0;
        else if (!aDate) cmp = 1;  // 空值总是放最后
        else if (!bDate) cmp = -1;
        else cmp = String(aDate).localeCompare(String(bDate));
        if (sortOrder === 'factory_desc' && cmp !== 0 && aDate && bDate) cmp = -cmp;
        break;
      }
      case 'created_desc':
      case 'created_asc': {
        cmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
        if (sortOrder === 'created_desc') cmp = -cmp;
        break;
      }
      case 'qty_desc':
      case 'qty_asc': {
        cmp = (a.quantity || 0) - (b.quantity || 0);
        if (sortOrder === 'qty_desc') cmp = -cmp;
        break;
      }
    }
    // 同等级兜底：按订单号稳定排序
    if (cmp === 0) cmp = (a.order_no || '').localeCompare(b.order_no || '');
    return cmp;
  });

  // 搜索维度统计（基于 base orders，不受搜索关键词影响）
  const dimensions = getSearchDimensions(baseOrders);

  // 是否有活跃的筛选条件
  const hasFilters = !!(searchQuery || customerFilter || factoryFilter || incotermFilter || typeFilter);

  // 统计超出交期的订单（考虑已批准/待审批的延期申请）
  const now = Date.now();

  // 辅助：获取订单的有效交期（已批准延期则用新日期）
  function getEffectiveDeliveryDate(o: any): { date: string; isDelayed: boolean } {
    const originalDate = o.incoterm === 'DDP' ? o.etd : (o.factory_date || o.etd);
    const approvedDelay = (o.delay_requests || [])
      .filter((d: any) => d.status === 'approved' && d.proposed_new_anchor_date)
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (approvedDelay) {
      return { date: approvedDelay.proposed_new_anchor_date, isDelayed: true };
    }
    return { date: originalDate, isDelayed: false };
  }

  // 辅助：订单是否有待审批的延期申请
  function hasPendingDelay(o: any): boolean {
    return (o.delay_requests || []).some((d: any) => d.status === 'pending');
  }

  // 出运关键节点：任意一个完成即视为已出货
  const SHIPPED_STEP_KEYS = new Set(['shipment_execute', 'customs_export', 'booking_done']);

  type OverdueOrder = { order: any; daysOver: number; pendingDelay: boolean; approved: boolean };
  const overdueOrders: OverdueOrder[] = (orders as any[]).reduce((acc: OverdueOrder[], o: any) => {
    // 1. lifecycle_status 已完成/已取消 → 跳过
    if (DONE_LIFECYCLE.has(o.lifecycle_status || '')) return acc;
    // 2. 出运关键节点已完成（实际已出货但数据未同步完）→ 跳过
    const hasShipped = (o.milestones || []).some((m: any) =>
      SHIPPED_STEP_KEYS.has(m.step_key) && (String(m.status || '').toLowerCase() === 'done' || m.status === '已完成')
    );
    if (hasShipped) return acc;
    const { date: effectiveDate, isDelayed } = getEffectiveDeliveryDate(o);
    if (!effectiveDate) return acc;
    const daysOver = Math.ceil((now - new Date(effectiveDate + 'T23:59:59').getTime()) / 86400000);
    const allDone = (o.milestones || []).every((m: any) => {
      const s = String(m.status || '').toLowerCase();
      return s === 'done' || s === '已完成' || s === 'completed';
    });
    // 已批准新日期且新日期未过 → 不再超期
    if (daysOver <= 0 || allDone) return acc;
    // 进入超期列表，标注是否有待审批延期
    acc.push({ order: o, daysOver, pendingDelay: hasPendingDelay(o), approved: isDelayed });
    return acc;
  }, []);

  // 分组：真超期（需要行动） vs 延期申请中（等待审批）
  const trueOverdue = overdueOrders.filter(x => !x.pendingDelay);
  const pendingDelayOrders = overdueOrders.filter(x => x.pendingDelay);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 超期订单警告已下线（2026-04-28）— 用户反馈"重复信息"，超期订单在 /ceo 待办区已聚合 */}

      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">订单列表</h1>
          <p className="mt-1 text-sm text-gray-500">
            共 {allOrders?.length || 0} 个订单
            {hasFilters && <span className="text-indigo-600 ml-1">（当前显示 {orders.length} 个）</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportProductionSheetButton />
          <Link
            href={purposeFilter === 'sample' ? '/orders/new?type=sample' : '/orders/new'}
            className="btn-primary inline-flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {purposeFilter === 'sample' ? '新建样品单' : '新建订单'}
          </Link>
        </div>
      </div>

      {/* 用途切换：订单 vs 样品单 */}
      <div className="flex gap-2 mb-4">
        {[
          { key: 'production', label: '📦 订单', count: totalProduction },
          { key: 'sample', label: '🧪 样品单', count: totalSample },
        ].map(tab => (
          <Link
            key={tab.key}
            href={`/orders?purpose=${tab.key}&status=active`}
            className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${
              purposeFilter === tab.key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {tab.label}（{tab.count}）
          </Link>
        ))}
      </div>

      {/* 状态筛选 */}
      <div className="flex gap-1 mb-4">
        {[
          { key: 'active', label: '进行中', count: activeOrders.length },
          { key: 'completed', label: '已完成', count: completedOrders.length },
        ].map(tab => (
          <Link
            key={tab.key}
            href={`/orders?purpose=${purposeFilter}&status=${tab.key}`}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === tab.key
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tab.label} ({tab.count})
          </Link>
        ))}
      </div>

      {/* 排序 — 6 种模式 */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs text-gray-500 shrink-0">排序：</span>
        {([
          { key: 'factory_asc', label: '出厂日 ↑', hint: '最紧的在最上' },
          { key: 'factory_desc', label: '出厂日 ↓', hint: '最晚的在最上' },
          { key: 'created_desc', label: '新建 ↓', hint: '最新创建的在最上' },
          { key: 'created_asc', label: '新建 ↑', hint: '最早创建的在最上' },
          { key: 'qty_desc', label: '数量 ↓', hint: '大单在最上' },
          { key: 'qty_asc', label: '数量 ↑', hint: '小单在最上' },
        ] as const).map(opt => {
          const qsParts: string[] = [
            `purpose=${purposeFilter}`,
            `status=${statusFilter}`,
            `sort=${opt.key}`,
          ];
          if (searchQuery) qsParts.push(`q=${encodeURIComponent(searchQuery)}`);
          if (customerFilter) qsParts.push(`customer=${encodeURIComponent(customerFilter)}`);
          if (factoryFilter) qsParts.push(`factory=${encodeURIComponent(factoryFilter)}`);
          if (incotermFilter) qsParts.push(`incoterm=${incotermFilter}`);
          if (typeFilter) qsParts.push(`type=${typeFilter}`);
          const href = `/orders?${qsParts.join('&')}`;
          const active = sortOrder === opt.key;
          return (
            <Link
              key={opt.key}
              href={href}
              title={opt.hint}
              className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                active
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </Link>
          );
        })}
      </div>

      {/* 搜索 + 维度筛选 */}
      <OrderSearchBar
        currentQuery={searchQuery}
        currentStatus={statusFilter}
        currentCustomer={customerFilter}
        currentFactory={factoryFilter}
        currentIncoterm={incotermFilter}
        currentType={typeFilter}
        dimensions={dimensions}
      />

      {/* 活跃筛选条件标签 */}
      {hasFilters && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-gray-500">筛选条件：</span>
          {searchQuery && (
            <Link href={`/orders?status=${statusFilter}${customerFilter ? `&customer=${encodeURIComponent(customerFilter)}` : ''}${factoryFilter ? `&factory=${encodeURIComponent(factoryFilter)}` : ''}${incotermFilter ? `&incoterm=${incotermFilter}` : ''}${typeFilter ? `&type=${typeFilter}` : ''}`}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-indigo-100 text-indigo-700 hover:bg-indigo-200">
              搜索: {searchQuery} <span className="text-indigo-400">×</span>
            </Link>
          )}
          {customerFilter && (
            <Link href={`/orders?status=${statusFilter}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${factoryFilter ? `&factory=${encodeURIComponent(factoryFilter)}` : ''}${incotermFilter ? `&incoterm=${incotermFilter}` : ''}${typeFilter ? `&type=${typeFilter}` : ''}`}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200">
              客户: {customerFilter} <span className="text-blue-400">×</span>
            </Link>
          )}
          {factoryFilter && (
            <Link href={`/orders?status=${statusFilter}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${customerFilter ? `&customer=${encodeURIComponent(customerFilter)}` : ''}${incotermFilter ? `&incoterm=${incotermFilter}` : ''}${typeFilter ? `&type=${typeFilter}` : ''}`}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 hover:bg-green-200">
              工厂: {factoryFilter} <span className="text-green-400">×</span>
            </Link>
          )}
          {incotermFilter && (
            <Link href={`/orders?status=${statusFilter}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${customerFilter ? `&customer=${encodeURIComponent(customerFilter)}` : ''}${factoryFilter ? `&factory=${encodeURIComponent(factoryFilter)}` : ''}${typeFilter ? `&type=${typeFilter}` : ''}`}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 hover:bg-purple-200">
              贸易: {incotermFilter} <span className="text-purple-400">×</span>
            </Link>
          )}
          {typeFilter && (
            <Link href={`/orders?status=${statusFilter}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}${customerFilter ? `&customer=${encodeURIComponent(customerFilter)}` : ''}${factoryFilter ? `&factory=${encodeURIComponent(factoryFilter)}` : ''}${incotermFilter ? `&incoterm=${incotermFilter}` : ''}`}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200">
              类型: {{ trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' }[typeFilter] || typeFilter} <span className="text-amber-400">×</span>
            </Link>
          )}
          <Link href={`/orders?status=${statusFilter}`}
            className="text-xs text-gray-400 hover:text-gray-600 underline">
            清除全部
          </Link>
        </div>
      )}

      {!orders || orders.length === 0 ? (
        <div className="empty-state rounded-2xl bg-white border border-gray-200">
          <div className="empty-state-icon">{hasFilters ? '🔍' : '📦'}</div>
          <div className="empty-state-title">{hasFilters ? '没有找到匹配的订单' : '暂无订单'}</div>
          <p className="empty-state-desc mb-6">
            {hasFilters
              ? '试试调整搜索条件或筛选维度'
              : '开始创建您的第一个订单，追踪执行进度'
            }
          </p>
          {hasFilters ? (
            <Link href={`/orders?status=${statusFilter}`} className="btn-primary inline-flex items-center gap-2">
              清除筛选
            </Link>
          ) : (
            <Link href="/orders/new" className="btn-primary inline-flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              创建订单
            </Link>
          )}
        </div>
      ) : (
        <>
        {/* Mobile: card layout */}
        <div className="md:hidden space-y-3">
          {orders.map((order: any) => {
            const milestones = (order as any).milestones || [];
            const status = computeOrderStatus(milestones);
            const statusConfig = {
              GREEN: { label: '正常', class: 'bg-green-100 text-green-700' },
              YELLOW: { label: '注意', class: 'bg-yellow-100 text-yellow-700' },
              RED: { label: '风险', class: 'bg-red-100 text-red-700' },
            }[status.color];
            const phases = computePhases(milestones);
            const dateStr = order.incoterm === 'FOB' ? formatDate(order.etd) : formatDate(order.warehouse_due_date);

            return (
              <Link key={order.id} href={`/orders/${order.id}`} className="block bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow active:bg-gray-50">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-semibold text-gray-900 text-sm">{order.order_no}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{order.customer_name}{(order as any).factory_name ? ` · ${(order as any).factory_name}` : ''}</div>
                    {(order as any).po_number && <div className="text-xs text-gray-400 mt-0.5">PO: {(order as any).po_number}</div>}
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusConfig.class}`}>{statusConfig.label}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                  <span>{order.incoterm}</span>
                  <span>{dateStr}</span>
                  <span>{({ trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' }[order.order_type as string] || order.order_type)}</span>
                </div>
                <div className="flex gap-0.5">
                  {phases.map((p: any, i: number) => (
                    <div key={i} className={`h-1.5 flex-1 rounded-sm ${
                      p.allDone ? 'bg-green-500' : p.blocked ? 'bg-orange-400' : p.active ? 'bg-blue-500' : p.done > 0 ? 'bg-blue-200' : 'bg-gray-200'
                    }`} />
                  ))}
                </div>
              </Link>
            );
          })}
        </div>

        {/* Desktop: table layout */}
        <div className="hidden md:block bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="table-modern">
            <thead>
              <tr>
                <th>订单号</th>
                <th>内部单号</th>
                <th>客户</th>
                <th>工厂</th>
                <th>款号/PO</th>
                <th>数量</th>
                <th>贸易条款</th>
                <th>关键日期</th>
                <th>类型</th>
                <th>状态</th>
                <th>阶段进度</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order: any) => {
                const milestones = (order as any).milestones || [];
                const status = computeOrderStatus(milestones);
                const statusConfig = {
                  GREEN: { label: '正常', class: 'badge-success' },
                  YELLOW: { label: '注意', class: 'badge-warning' },
                  RED: { label: '风险', class: 'badge-danger' },
                }[status.color];

                const typeLabels: Record<string, string> = { trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急' };
                const typeColors: Record<string, string> = { trial: 'bg-blue-100 text-blue-700', bulk: 'bg-gray-100 text-gray-700', repeat: 'bg-green-100 text-green-700', urgent: 'bg-red-100 text-red-700' };

                return (
                  <tr key={order.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{order.order_no}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${typeColors[order.order_type] || 'bg-gray-100 text-gray-600'}`}>
                          {typeLabels[order.order_type] || order.order_type}
                        </span>
                      </div>
                    </td>
                    <td>
                      <InlineEditField
                        orderId={order.id}
                        field="internal_order_no"
                        value={(order as any).internal_order_no}
                        placeholder="填写"
                        locked={true}
                        lockedMessage="内部单号已填写，修改需要财务审批。请联系财务或管理员。"
                      />
                    </td>
                    <td>
                      <Link href={`/orders?status=${statusFilter}&customer=${encodeURIComponent(order.customer_name)}`}
                        className="text-gray-700 hover:text-indigo-600 hover:underline">{order.customer_name}</Link>
                    </td>
                    <td>
                      {(order as any).factory_name ? (
                        <Link href={`/orders?status=${statusFilter}&factory=${encodeURIComponent((order as any).factory_name)}`}
                          className="text-gray-600 hover:text-indigo-600 hover:underline">{(order as any).factory_name}</Link>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                <td>
                  <div className="text-sm text-gray-900">{(order as any).style_no || '-'}</div>
                  {(order as any).po_number && <div className="text-xs text-gray-500">{(order as any).po_number}</div>}
                </td>
                    <td>
                      <span className="text-gray-700 font-medium">{order.quantity ? `${order.quantity}件` : '—'}</span>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{{ FOB: 'FOB', DDP: 'DDP', RMB_EX_TAX: '人民币不含税', RMB_INC_TAX: '人民币含税' }[order.incoterm as string] || order.incoterm}</span>
                    </td>
                    <td>
                      {(() => {
                        const originalKeyDate = order.incoterm === 'DDP'
                          ? order.etd
                          : ((order as any).factory_date || order.etd);
                        const dateLabel = order.incoterm === 'DDP' ? 'ETD' : '出厂';
                        if (!originalKeyDate) return <span className="text-gray-400 text-xs">—</span>;
                        // 检查是否有已批准的延期（用新日期计算超期）
                        const approvedDelay = ((order as any).delay_requests || [])
                          .filter((d: any) => d.status === 'approved' && d.proposed_new_anchor_date)
                          .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
                        const effectiveDate = approvedDelay ? approvedDelay.proposed_new_anchor_date : originalKeyDate;
                        const hasPending = ((order as any).delay_requests || []).some((d: any) => d.status === 'pending');
                        const daysOver = Math.ceil((Date.now() - new Date(effectiveDate + 'T23:59:59').getTime()) / 86400000);
                        const allMilestoneDone = milestones.every((m: any) => _isDone(m.status));
                        const lifecycleDone = DONE_LIFECYCLE.has((order as any).lifecycle_status || '');
                        const isOverdue = daysOver > 0 && !allMilestoneDone && !lifecycleDone;
                        return (
                          <div>
                            <span className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                              {dateLabel} {formatDate(originalKeyDate)}
                            </span>
                            {isOverdue && hasPending && (
                              <div className="text-xs text-amber-600 font-medium">⏳ 延期申请中</div>
                            )}
                            {isOverdue && !hasPending && (
                              <div className="text-xs text-red-500 font-medium">⚠ 超期 {daysOver} 天</div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td>
                      <span className={`badge ${order.order_type === 'sample' ? 'badge-info' : 'badge-neutral'}`}>
                        {({ trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' }[order.order_type as string] || order.order_type)}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${statusConfig.class}`}>
                        {statusConfig.label}
                      </span>
                    </td>
                <td>
                  {(() => {
                    const phases = computePhases(milestones);
                    const currentPhase = phases.find(p => p.active) || phases.find(p => !p.allDone && p.total > 0);
                    const totalDone = milestones.filter((m: any) => _isDone(m.status)).length;
                    const allDone = phases.every(p => p.allDone || p.total === 0);
                    return (
                      <div>
                        <div className="flex gap-0.5 mb-1" title={phases.map(p => `${p.label}: ${p.done}/${p.total}`).join(' | ')}>
                          {phases.map((p, i) => (
                            <div key={i} className={`h-2 flex-1 rounded-sm ${
                              p.allDone ? 'bg-green-500' :
                              p.blocked ? 'bg-orange-400' :
                              p.active ? 'bg-blue-500' :
                              p.done > 0 ? 'bg-blue-200' :
                              'bg-gray-200'
                            }`} />
                          ))}
                        </div>
                        <div className="text-xs text-gray-500">
                          {allDone ? (
                            <span className="text-green-600 font-medium">已完成</span>
                          ) : currentPhase ? (
                            <span>{currentPhase.label} <span className="text-gray-400">{totalDone}/{milestones.length}</span></span>
                          ) : (
                            <span className="text-gray-400">{totalDone}/{milestones.length}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </td>
                    <td>
                      {order.id ? (
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 font-medium text-sm transition-colors"
                        >
                          查看详情
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                      ) : (
                        <span className="text-gray-400 text-sm">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
