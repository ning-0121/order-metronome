/**
 * Pending Approvals Service — 多源待审批聚合
 *
 * 业务背景：
 *  系统中"待审批"散落 7 处（延期 / CEO批 / 价格 / 订单确认 / Agent建议 /
 *  采购补单 / 付款冻结），缺一个统一入口让老板和管理员一眼看全。
 *
 * 设计原则：
 *  - 只读聚合，不引入新表
 *  - 按角色过滤（admin 看全部，finance 只看价格/付款，sales 看延期/确认）
 *  - 每条结果带 sourceUrl，点击直达处理页
 *  - 性能：所有查询并行
 */

import type { ServiceResult } from './types';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';

/**
 * 当用户是 admin 时返回 service-role 客户端绕过 RLS。
 *
 * 业务理由：本页面已在 page-level 做了 admin 角色校验（pending-approvals/page.tsx:40），
 * service 内部再过一次 RLS 反而会因为多角色策略不全 / 老策略残留导致 admin 看不到自己有权处理的项。
 * 已经发生过事故（2026-05-26 alex 是 DB role=admin，但「延期申请」仍显示 0），
 * 改成 admin 路径直接用 service-role，保证看得到所有数据；非 admin 仍走 RLS。
 */
// 2026-07-11:原来只有 admin 用 service-role,其余(含 order_manager/sales_manager 等监督经理)走 user session
//   → 被 orders RLS 限成只看自己的单,看不到别人订单的待审批(高洁收不到延期的根因之一)。
//   监督/管理角色(CAN_SEE_ALL_ORDERS)本就"看所有订单",一律给 service-role 看全量待审批。
const CAN_SEE_ALL_APPROVALS = ['admin', 'finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'];
function clientFor(ctx: UserContext, fallback: any): any {
  if (ctx.roles?.some(r => CAN_SEE_ALL_APPROVALS.includes(r))) {
    try {
      return createServiceRoleClient();
    } catch (e: any) {
      console.warn('[pending-approvals] service-role 不可用，降级到 user session:', e?.message);
      return fallback;
    }
  }
  return fallback;
}

// ── 类型 ──────────────────────────────────────────────────────

export type ApprovalCategory =
  | 'delay'           // 延期申请
  | 'amendment'       // 订单修改/改单申请
  | 'order_cancel'    // 取消订单申请
  | 'ceo_import'      // CEO 待批进行中导入订单
  | 'price'           // 预订单价格审批
  | 'agent_action'    // Agent 待执行动作
  | 'order_confirm'   // 订单确认模块（面料/颜色/印花/包装）
  | 'payment_hold'    // 付款冻结
  | 'po_approval'     // 采购单审批(2026-08-18:此前 PO 审批不在待审批中心,财务/采购经理看不见 → 反复"审批不达")
  | 'supplement'      // 补采购财务审批(2026-08-18:同一个洞的第二个实例 —— 批准入口只藏在核料页)
  | 'shipment_release'// 出货放行待财务批(2026-08-19:1022919 死胡同 —— 业务被告知等财务,财务无处可见)
  | 'baseline_over'   // 超预算采购待财务批(审计线①命中:与补采共用抽屉却没进中心)
  | 'purpose_change'  // 改订单用途待财务/管理员批(P1 §8:此前零通知+仅订单页横幅)
  | 'document_review' // PI/CI 单据待审批(P1 §8:同上)
  | 'payment_request' // 付款申请已推财务待回执(P1 §9:站内此前无任何列表;处理在外部财务系统)
  | 'supplier_change';// 已下单采购单改供应商待财务批(2026-08-19 CEO:已付款单选错供应商也要能改)

export interface PendingApprovalItem {
  id: string;
  category: ApprovalCategory;
  title: string;
  subtitle?: string;
  /** 关联订单（如有） */
  orderId?: string;
  orderNo?: string;
  customerName?: string;
  /** 处理跳转 URL */
  sourceUrl: string;
  /** 创建时间，用于排序和"卡了几天" */
  createdAt: string;
  /** 几天前创建 */
  ageDays: number;
  /** 是否对当前用户角色可处理 */
  actionable: boolean;
}

export interface PendingApprovalSummary {
  total: number;
  byCategory: Record<ApprovalCategory, number>;
  /** 当前用户可处理的数量（actionable=true） */
  actionableCount: number;
  items: PendingApprovalItem[];
}

interface UserContext {
  userId: string;
  /** 角色集合：admin / finance / sales / production_manager / production / merchandiser / admin_assistant */
  roles: string[];
}

// ── 工具 ──────────────────────────────────────────────────────

function ageDaysFrom(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function hasAnyRole(roles: string[], wanted: string[]): boolean {
  return roles.some(r => wanted.includes(r));
}

// ── 各源采集函数 ───────────────────────────────────────────────

async function collectDelayRequests(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);

  // 2026-05-26 修复：原本用 PostgREST 嵌套 join orders(order_no, customer_name)，
  // 但 delay_requests 表没声明 FK 到 orders（或 schema cache 不认），整个查询
  // fail 返回 null → 显示 0。改成两次独立查询。
  const { data: delays, error: delaysError } = await (client.from('delay_requests') as any)
    .select('id, order_id, reason, delay_days, status, created_at, requested_by, approval_chain, current_step')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);

  if (delaysError) {
    console.warn('[collectDelayRequests] query failed:', delaysError.message);
    return [];
  }
  if (!delays || delays.length === 0) return [];

  // 拉关联订单的基本信息（id / order_no / customer_name）
  const orderIds = Array.from(new Set((delays as any[]).map((d) => d.order_id).filter(Boolean)));
  const orderMap = new Map<string, { order_no: string; customer_name: string }>();
  if (orderIds.length > 0) {
    const { data: orders } = await (client.from('orders') as any)
      .select('id, order_no, customer_name')
      .in('id', orderIds);
    for (const o of (orders || []) as any[]) {
      orderMap.set(o.id, { order_no: o.order_no, customer_name: o.customer_name });
    }
  }

  // 2026-07-24 修:原来按角色一刀切(production_manager 在名单里)→ 生产经理看到所有延期单,
  //   包括路由给业务开发(sales)的业务执行延期。改为**按每条单的审批链**筛:
  //   ① 全局审批经理(admin/order_manager/sales_manager,与 delays.ts CAN_APPROVE_DELAY 一致)可代任一步 → 看全部;
  //   ② 其他角色(如生产主管 production_manager)只看"当前待批角色=自己"的单。
  const GLOBAL_DELAY_APPROVERS = ['admin', 'order_manager', 'sales_manager'];
  const isGlobalApprover = hasAnyRole(ctx.roles, GLOBAL_DELAY_APPROVERS);
  const currentStepRole = (r: any): string | null => {
    const chain: string[] = Array.isArray(r.approval_chain) ? r.approval_chain : [];
    const step = Number(r.current_step) || 0;
    return chain[step] || null;
  };

  return (delays as any[])
    // 只保留"该由我处理"的延期:全局经理看全部;其余仅当自己是当前待批角色。
    .filter((r) => isGlobalApprover || (() => { const role = currentStepRole(r); return !!role && ctx.roles.includes(role); })())
    .map((r) => {
      const order = orderMap.get(r.order_id);
      return {
        id: r.id,
        category: 'delay' as ApprovalCategory,
        title: `${order?.order_no || '?'} 申请延期 ${r.delay_days || '?'} 天`,
        subtitle: r.reason ? r.reason.slice(0, 50) : undefined,
        orderId: r.order_id,
        orderNo: order?.order_no,
        customerName: order?.customer_name,
        sourceUrl: `/orders/${r.order_id}#delay-${r.id}`,
        createdAt: r.created_at,
        ageDays: ageDaysFrom(r.created_at),
        actionable: true,   // 已按链筛,留下的都是我能处理的
      };
    });
}

// 订单修改/改单申请(2026-07-11 补:原来待审批中心根本没采集改单 → 经理在此看不到任何改单)
async function collectAmendments(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);
  const { data: rows, error } = await (client.from('order_amendments') as any)
    .select('id, order_id, reason, fields_to_change, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) { console.warn('[collectAmendments] query failed:', error.message); return []; }
  if (!rows || rows.length === 0) return [];

  const orderIds = Array.from(new Set((rows as any[]).map(r => r.order_id).filter(Boolean)));
  const orderMap = new Map<string, { order_no: string; customer_name: string }>();
  if (orderIds.length > 0) {
    const { data: orders } = await (client.from('orders') as any).select('id, order_no, customer_name').in('id', orderIds);
    for (const o of (orders || []) as any[]) orderMap.set(o.id, { order_no: o.order_no, customer_name: o.customer_name });
  }
  // 与 approveOrderAmendment 的权限一致:admin/order_manager/sales_manager 可审批改单
  const canApprove = hasAnyRole(ctx.roles, ['admin', 'order_manager', 'sales_manager']);

  return (rows as any[]).map((r) => {
    const order = orderMap.get(r.order_id);
    const changed = r.fields_to_change && typeof r.fields_to_change === 'object' ? Object.keys(r.fields_to_change).join('、') : '';
    return {
      id: r.id,
      category: 'amendment' as ApprovalCategory,
      title: `${order?.order_no || '?'} 订单修改申请${changed ? `（${changed}）` : ''}`,
      subtitle: r.reason ? String(r.reason).slice(0, 50) : undefined,
      orderId: r.order_id,
      orderNo: order?.order_no,
      customerName: order?.customer_name,
      sourceUrl: `/orders/${r.order_id}`,
      createdAt: r.created_at,
      ageDays: ageDaysFrom(r.created_at),
      actionable: canApprove,
    };
  });
}

const CANCEL_REASON_LABELS: Record<string, string> = {
  customer_cancel: '客户取消',
  pricing_issue: '价格问题',
  capacity_issue: '产能问题',
  risk_control: '风控',
  other: '其他',
};

async function collectCancelRequests(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);

  // 两次独立查询（同 delays：避免依赖 PostgREST FK 嵌套缓存）
  const { data: cancels, error } = await (client.from('cancel_requests') as any)
    .select('id, order_id, reason_type, reason_detail, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) {
    console.warn('[collectCancelRequests] query failed:', error.message);
    return [];
  }
  if (!cancels || cancels.length === 0) return [];

  const orderIds = Array.from(new Set((cancels as any[]).map((c) => c.order_id).filter(Boolean)));
  const orderMap = new Map<string, { order_no: string; customer_name: string }>();
  if (orderIds.length > 0) {
    const { data: orders } = await (client.from('orders') as any)
      .select('id, order_no, customer_name')
      .in('id', orderIds);
    for (const o of (orders || []) as any[]) {
      orderMap.set(o.id, { order_no: o.order_no, customer_name: o.customer_name });
    }
  }

  // 取消审批仅 admin（decideCancelAction 的权限）
  const canApprove = hasAnyRole(ctx.roles, ['admin']);

  return (cancels as any[]).map((r) => {
    const order = orderMap.get(r.order_id);
    const reason = CANCEL_REASON_LABELS[r.reason_type] || r.reason_type;
    return {
      id: r.id,
      category: 'order_cancel' as ApprovalCategory,
      title: `${order?.order_no || '?'} 申请取消订单（${reason}）`,
      subtitle: r.reason_detail ? String(r.reason_detail).slice(0, 60) : undefined,
      orderId: r.order_id,
      orderNo: order?.order_no,
      customerName: order?.customer_name,
      sourceUrl: `/orders/${r.order_id}`,
      createdAt: r.created_at,
      ageDays: ageDaysFrom(r.created_at),
      actionable: canApprove,
    };
  });
}

async function collectCeoImportApprovals(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  // CEO 审批进行中导入订单：lifecycle_status='pending_approval'
  // clientFor：admin 走 service-role，避免 orders RLS 对 admin 不全 → 漏看待审批订单（同 delays 的修复）
  const client = clientFor(ctx, supabase);
  const { data } = await (client.from('orders') as any)
    .select('id, order_no, customer_name, import_current_step, import_reason, imported_at, notes, created_at')
    .eq('lifecycle_status', 'pending_approval')
    .order('imported_at', { ascending: true, nullsFirst: false })
    .limit(100);

  // 仅 admin 或 finance 可批
  const canApprove = hasAnyRole(ctx.roles, ['admin', 'finance']);

  return ((data || []) as any[]).map(r => {
    const ts = r.imported_at || r.created_at;
    return {
      id: r.id,
      category: 'ceo_import' as ApprovalCategory,
      title: `${r.order_no} 待 CEO 审批（进行中导入）`,
      subtitle: r.import_current_step ? `当前节点：${r.import_current_step}` : '历史导入订单',
      orderId: r.id,
      orderNo: r.order_no,
      customerName: r.customer_name,
      sourceUrl: `/orders/${r.id}`,
      createdAt: ts,
      ageDays: ageDaysFrom(ts),
      actionable: canApprove,
    };
  });
}

async function collectPriceApprovals(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);
  // 价格防线(2026-08-04 CEO:「对于价格,她看不到才对」)。
  //
  // 报价审批条目带 summary 自由文本,现在装的是「发现 4 项差异,请人工复核」这类,
  // 但那是个**自由字段**,哪天写进单价/金额就直接漏给了看不到财务的人
  // (行政督办有 CAN_SEE_ALL_ORDERS 所以能看全部待审批,却不在 CAN_SEE_FINANCIALS)。
  // 这里按「能不能看财务」直接掐掉整个价格类目 —— 不是掩码 summary,是压根不返回,
  // 免得以后有人往 title/subtitle 里加字段又漏一次。
  if (!hasRoleInGroup(ctx.roles as any, 'CAN_SEE_FINANCIALS')) return [];

  const { data } = await (client.from('pre_order_price_approvals') as any)
    .select('id, customer_name, po_number, summary, status, created_at, expires_at, requested_by')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);

  // 角色审计修:报价审批真实门禁是 CAN_APPROVE_PRICE=['admin','sales_manager'](见 price-approvals.ts:19),
  //   之前写成 ['admin','finance'] → finance 被标「可处理」点进 /admin/price-approvals 被拒(死链),
  //   sales_manager(真审批人)被标「不归我处理」漏批。对齐真实权限。
  const canApprove = hasAnyRole(ctx.roles, ['admin', 'sales_manager']);

  return ((data || []) as any[]).map(r => ({
    id: r.id,
    category: 'price' as ApprovalCategory,
    title: `${r.customer_name || '?'} 报价审批${r.po_number ? `（PO ${r.po_number}）` : ''}`,
    subtitle: r.summary ? r.summary.slice(0, 60) : undefined,
    sourceUrl: `/admin/price-approvals#${r.id}`,
    createdAt: r.created_at,
    ageDays: ageDaysFrom(r.created_at),
    actionable: canApprove,
  }));
}

async function collectAgentActions(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);
  const { data } = await (client.from('agent_actions') as any)
    .select('id, order_id, action_type, title, summary, status, created_at, orders(order_no, customer_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false }) // 最新建议优先
    .limit(50);

  const canApprove = hasAnyRole(ctx.roles, ['admin']);

  return ((data || []) as any[]).map(r => ({
    id: r.id,
    category: 'agent_action' as ApprovalCategory,
    title: `🤖 ${r.title || r.action_type || 'Agent 建议'}`,
    subtitle: r.summary?.slice(0, 60) || (r.orders?.order_no ? `订单 ${r.orders.order_no}` : undefined),
    orderId: r.order_id,
    orderNo: r.orders?.order_no,
    customerName: r.orders?.customer_name,
    // 一律指 /admin/agent:执行/忽略面板在那里(2026-08-19 B4;订单页没有 Agent 处理 UI,指过去是死胡同)
    sourceUrl: '/admin/agent',
    createdAt: r.created_at,
    ageDays: ageDaysFrom(r.created_at),
    actionable: canApprove,
  }));
}

async function collectPaymentHolds(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const client = clientFor(ctx, supabase);
  const { data } = await (client.from('order_financials') as any)
    .select('id, order_id, payment_hold, updated_at, orders(order_no, customer_name, lifecycle_status)')
    .eq('payment_hold', true)
    .limit(100);

  const canApprove = hasAnyRole(ctx.roles, ['admin', 'finance']);

  return ((data || []) as any[])
    // 排除已完成/已取消的订单
    .filter(r => !['completed', '已完成', 'cancelled', '已取消'].includes(r.orders?.lifecycle_status || ''))
    .map(r => ({
      id: r.id,
      category: 'payment_hold' as ApprovalCategory,
      title: `💳 ${r.orders?.order_no || '?'} 付款已冻结`,
      subtitle: r.orders?.customer_name ? `客户：${r.orders.customer_name}` : undefined,
      orderId: r.order_id,
      orderNo: r.orders?.order_no,
      customerName: r.orders?.customer_name,
      sourceUrl: `/orders/${r.order_id}#financials`,
      createdAt: r.updated_at,
      ageDays: ageDaysFrom(r.updated_at),
      actionable: canApprove,
    }));
}

async function collectOrderConfirmations(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  // 2026-07-09 用户拍板:订单确认模块(面料颜色/尺码配比/LOGO印花/包装)在订单详情里没有可确认的入口,
  //   一直挂在审批中心是"点进去无处可确认"的空提示 → 不再进审批中心。数据仍在 order_confirmations,
  //   由订单评审 checklist 自动推进,不靠人在审批中心点。
  return [];
  // eslint-disable-next-line no-unreachable
  // 订单确认模块（面料/颜色/印花/包装）not_started 或 pending
  // 只对 active/draft 订单关注
  const client = clientFor(ctx, supabase);
  const { data } = await (client.from('order_confirmations') as any)
    .select('id, order_id, module, status, updated_at, orders(order_no, customer_name, lifecycle_status, factory_date)')
    .in('status', ['not_started', 'pending'])
    .limit(200);

  const canApprove = hasAnyRole(ctx.roles, ['admin', 'sales']);

  return ((data || []) as any[])
    // 排除已完成的订单
    .filter(r => !['completed', '已完成', 'cancelled', '已取消'].includes(r.orders?.lifecycle_status || ''))
    .map(r => {
      const moduleLabels: Record<string, string> = {
        fabric_color:   '面料颜色确认',
        size_breakdown: '尺码配比确认',
        logo_print:     'LOGO/印花确认',
        packaging_label:'包装/唛头确认',
      };
      const label = moduleLabels[r.module] || r.module;
      return {
        id: r.id,
        category: 'order_confirm' as ApprovalCategory,
        title: `📋 ${r.orders?.order_no || '?'} ${label}`,
        subtitle: r.orders?.factory_date ? `出厂 ${r.orders.factory_date}` : r.orders?.customer_name,
        orderId: r.order_id,
        orderNo: r.orders?.order_no,
        customerName: r.orders?.customer_name,
        sourceUrl: `/orders/${r.order_id}#confirmations`,
        createdAt: r.updated_at,
        ageDays: ageDaysFrom(r.updated_at),
        actionable: canApprove,
      };
    });
}

// ── 主聚合函数 ────────────────────────────────────────────────

/**
 * 聚合所有待审批项
 */
export async function getPendingApprovals(
  supabase: any,
  ctx: UserContext,
): Promise<ServiceResult<PendingApprovalSummary>> {
  try {
    // 7 个数据源并行
    const [
      delays,
      amendments,
      cancels,
      ceoImports,
      prices,
      agentActions,
      paymentHolds,
      confirmations,
      poApprovals,
      supplements,
      shipmentReleases,
      baselineOvers,
      purposeChanges,
      documentReviews,
      paymentRequests,
      supplierChanges,
    ] = await Promise.all([
      collectDelayRequests(supabase, ctx).catch(e => { console.warn('[pending-approvals] delays failed:', e?.message); return []; }),
      collectAmendments(supabase, ctx).catch(e => { console.warn('[pending-approvals] amendments failed:', e?.message); return []; }),
      collectCancelRequests(supabase, ctx).catch(e => { console.warn('[pending-approvals] cancels failed:', e?.message); return []; }),
      collectCeoImportApprovals(supabase, ctx).catch(e => { console.warn('[pending-approvals] ceo failed:', e?.message); return []; }),
      collectPriceApprovals(supabase, ctx).catch(e => { console.warn('[pending-approvals] price failed:', e?.message); return []; }),
      collectAgentActions(supabase, ctx).catch(e => { console.warn('[pending-approvals] agent failed:', e?.message); return []; }),
      collectPaymentHolds(supabase, ctx).catch(e => { console.warn('[pending-approvals] hold failed:', e?.message); return []; }),
      collectOrderConfirmations(supabase, ctx).catch(e => { console.warn('[pending-approvals] confirm failed:', e?.message); return []; }),
      collectPoApprovals(ctx).catch(e => { console.warn('[pending-approvals] po failed:', e?.message); return []; }),
      collectSupplementApprovals(ctx).catch(e => { console.warn('[pending-approvals] supplement failed:', e?.message); return []; }),
      collectShipmentReleases(ctx).catch(e => { console.warn('[pending-approvals] shipment failed:', e?.message); return []; }),
      collectBaselineOverItems(ctx).catch(e => { console.warn('[pending-approvals] baseline failed:', e?.message); return []; }),
      collectPurposeChanges(ctx).catch(e => { console.warn('[pending-approvals] purpose failed:', e?.message); return []; }),
      collectDocumentReviews(ctx).catch(e => { console.warn('[pending-approvals] docs failed:', e?.message); return []; }),
      collectPaymentRequests(ctx).catch(e => { console.warn('[pending-approvals] payment failed:', e?.message); return []; }),
      collectSupplierChanges(ctx).catch(e => { console.warn('[pending-approvals] supplier_change failed:', e?.message); return []; }),
    ]);

    const allItems = [
      ...delays, ...amendments, ...cancels, ...ceoImports, ...prices, ...agentActions, ...paymentHolds, ...confirmations, ...poApprovals, ...supplements, ...shipmentReleases, ...baselineOvers, ...purposeChanges, ...documentReviews, ...paymentRequests, ...supplierChanges,
    ];

    // 按 ageDays 倒序（卡得越久越靠前）
    allItems.sort((a, b) => b.ageDays - a.ageDays);

    const byCategory: Record<ApprovalCategory, number> = {
      delay:         delays.length,
      amendment:     amendments.length,
      order_cancel:  cancels.length,
      ceo_import:    ceoImports.length,
      price:         prices.length,
      agent_action:  agentActions.length,
      payment_hold:  paymentHolds.length,
      order_confirm: confirmations.length,
      po_approval:   poApprovals.length,
      supplement:    supplements.length,
      shipment_release: shipmentReleases.length,
      baseline_over: baselineOvers.length,
      purpose_change: purposeChanges.length,
      document_review: documentReviews.length,
      payment_request: paymentRequests.length,
      supplier_change: supplierChanges.length,
    };

    const actionableCount = allItems.filter(i => i.actionable).length;

    return {
      ok: true,
      data: {
        total: allItems.length,
        byCategory,
        actionableCount,
        items: allItems,
      },
    };
  } catch (err: any) {
    return { ok: false, error: `聚合失败：${err?.message || '未知错误'}` };
  }
}

/**
 * 仅返回数量汇总（用于 dashboard 卡片，不返回具体列表）
 */
export async function getPendingApprovalsCount(
  supabase: any,
  ctx: UserContext,
): Promise<ServiceResult<{ total: number; byCategory: Record<ApprovalCategory, number>; actionableCount: number }>> {
  const result = await getPendingApprovals(supabase, ctx);
  if (!result.ok) return result;
  const { total, byCategory, actionableCount } = result.data;
  return { ok: true, data: { total, byCategory, actionableCount } };
}

// ── 类目元数据（UI 用） ───────────────────────────────────────

async function collectPoApprovals(ctx: UserContext): Promise<PendingApprovalItem[]> {
  // 读走 repository(内部 service-role):财务的 session 未必过得了 purchase_orders RLS,
  // 读不到 → 类别静默空 → 又一次"审批不达"。
  // 可见性红线(CLAUDE.md):采购金额=价格信息,不暴露给 merchandiser/production/admin_assistant。
  // 本类别只对 审批相关角色 可见,其他角色直接空(不是"可见但只读")。
  if (!hasAnyRole(ctx.roles, ['admin', 'finance', 'procurement', 'procurement_manager'])) return [];
  const { listPendingApprovalPurchaseOrders } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { reasonsCn } = await import('@/lib/procurement/approval');
  const { data: pos, error } = await listPendingApprovalPurchaseOrders();
  if (error) { console.warn('[collectPoApprovals] failed:', error); return []; }
  return pos.map((po) => {
    const needsFinance = po.approvalRequiredBy.includes('finance');
    const needsProcMgr = po.approvalRequiredBy.includes('procurement');
    // actionable:按 approval_required_by 精确给 —— 财务审财务的,采购经理审采购的;admin 全可
    const actionable = hasAnyRole(ctx.roles, [
      'admin',
      ...(needsFinance ? ['finance'] : []),
      ...(needsProcMgr ? ['procurement_manager'] : []),
    ]);
    const scope = [needsFinance ? '财务' : null, needsProcMgr ? '采购经理' : null].filter(Boolean).join('+') || '审批';
    return {
      id: po.id,
      category: 'po_approval' as ApprovalCategory,
      title: `${po.poNo || 'PO'} 待${scope}审批 ¥${(po.totalAmount ?? 0).toLocaleString()}${po.supplierName ? `（${po.supplierName}）` : ''}`,
      subtitle: [po.orderRefs.length ? `订单 ${po.orderRefs.join('、')}` : null, po.approvalReasons.length ? reasonsCn(po.approvalReasons) : null].filter(Boolean).join(' · ') || undefined,
      orderId: po.firstOrderId ?? undefined,
      sourceUrl: `/procurement/po/${po.id}`,
      createdAt: po.createdAt,
      ageDays: ageDaysFrom(po.createdAt),
      actionable,
    };
  });
}

async function collectSupplementApprovals(ctx: UserContext): Promise<PendingApprovalItem[]> {
  // 可见性红线同 po_approval:补采购含数量/物料,只给审批相关角色
  if (!hasAnyRole(ctx.roles, ['admin', 'finance', 'procurement', 'procurement_manager'])) return [];
  const { listPendingSupplementItems } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingSupplementItems();
  if (error) { console.warn('[collectSupplementApprovals] failed:', error); return []; }
  // approveSupplement 的权限是 财务/管理员(FINANCE_ROLES)
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id,
    category: 'supplement' as ApprovalCategory,
    title: `补采购待财务批:${it.materialName || '?'}${it.color ? ' · ' + it.color : ''}${it.qty != null ? ` ${it.qty}${it.unit || ''}` : ''}`,
    subtitle: [it.orderRef ? `订单 ${it.orderRef}` : null, it.reason].filter(Boolean).join(' · ') || undefined,
    orderId: it.orderId,
    orderNo: it.orderRef ?? undefined,
    sourceUrl: `/procurement/verify/${it.orderId}`,
    createdAt: it.createdAt,
    ageDays: ageDaysFrom(it.createdAt),
    actionable,
  }));
}

async function collectShipmentReleases(ctx: UserContext): Promise<PendingApprovalItem[]> {
  if (!hasAnyRole(ctx.roles, ['admin', 'finance', 'sales_manager', 'order_manager'])) return [];
  const { listPendingShipmentReleases } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingShipmentReleases();
  if (error) { console.warn('[collectShipmentReleases] failed:', error); return []; }
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id,
    category: 'shipment_release' as ApprovalCategory,
    title: `出货放行待财务批:${it.orderRef || '?'}${it.qty != null ? ` · ${it.qty} 件` : ''}`,
    subtitle: it.customerName ? `客户 ${it.customerName}` : undefined,
    orderId: it.orderId,
    orderNo: it.orderRef ?? undefined,
    sourceUrl: `/orders/${it.orderId}?tab=shipment`,
    createdAt: it.requestedAt,
    ageDays: ageDaysFrom(it.requestedAt),
    actionable,
  }));
}

async function collectBaselineOverItems(ctx: UserContext): Promise<PendingApprovalItem[]> {
  if (!hasAnyRole(ctx.roles, ['admin', 'finance', 'procurement', 'procurement_manager'])) return [];
  const { listPendingBaselineOverItems } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingBaselineOverItems();
  if (error) { console.warn('[collectBaselineOverItems] failed:', error); return []; }
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id,
    category: 'baseline_over' as ApprovalCategory,
    title: `超预算待财务批:${it.materialName || '?'}${it.note ? `(${it.note})` : ''}`,
    subtitle: it.orderRef ? `订单 ${it.orderRef} · ${it.itemNo || ''}` : undefined,
    orderId: it.orderId,
    orderNo: it.orderRef ?? undefined,
    sourceUrl: `/procurement/verify/${it.orderId}`,
    createdAt: it.requestedAt,
    ageDays: ageDaysFrom(it.requestedAt),
    actionable,
  }));
}

async function collectPurposeChanges(ctx: UserContext): Promise<PendingApprovalItem[]> {
  if (!hasAnyRole(ctx.roles, ['admin', 'finance'])) return [];
  const { listPendingPurposeChanges } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingPurposeChanges();
  if (error) { console.warn('[collectPurposeChanges] failed:', error); return []; }
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id, category: 'purpose_change' as ApprovalCategory,
    title: `改用途待批:${it.orderRef || '?'} ${it.fromPurpose} → ${it.toPurpose}`,
    subtitle: it.reason ?? undefined,
    orderId: it.orderId, orderNo: it.orderRef ?? undefined,
    sourceUrl: `/orders/${it.orderId}`,
    createdAt: it.createdAt, ageDays: ageDaysFrom(it.createdAt), actionable,
  }));
}

async function collectSupplierChanges(ctx: UserContext): Promise<PendingApprovalItem[]> {
  if (!hasAnyRole(ctx.roles, ['admin', 'finance'])) return [];
  const { listPendingSupplierChanges } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingSupplierChanges();
  if (error) { console.warn('[collectSupplierChanges] failed:', error); return []; }
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id, category: 'supplier_change' as ApprovalCategory,
    title: `改供应商待批:${it.poNo || '采购单'} → ${it.toName || '?'}`,
    subtitle: `原供应商 ${it.fromName || '?'}${it.reason ? ' · ' + it.reason : ''}`,
    orderId: it.orderId ?? undefined, orderNo: it.orderRef ?? undefined,
    // 财务在订单页大货采购 tab 就地审批;带 focus 参数便于定位(tab 自身会展示待审批 PO)
    sourceUrl: it.orderId ? `/orders/${it.orderId}?tab=trade_purchase` : '/admin/pending-approvals',
    createdAt: it.requestedAt || new Date(0).toISOString(),
    ageDays: ageDaysFrom(it.requestedAt || new Date().toISOString()), actionable,
  }));
}

async function collectDocumentReviews(ctx: UserContext): Promise<PendingApprovalItem[]> {
  if (!hasAnyRole(ctx.roles, ['admin', 'finance'])) return [];
  const { listPendingDocumentReviews } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingDocumentReviews();
  if (error) { console.warn('[collectDocumentReviews] failed:', error); return []; }
  const actionable = hasAnyRole(ctx.roles, ['admin', 'finance']);
  return items.map((it) => ({
    id: it.id, category: 'document_review' as ApprovalCategory,
    title: `单据待审批:${it.orderRef || '?'} · ${it.docType}`,
    orderId: it.orderId, orderNo: it.orderRef ?? undefined,
    sourceUrl: `/orders/${it.orderId}?tab=documents`,
    createdAt: it.createdAt, ageDays: ageDaysFrom(it.createdAt), actionable,
  }));
}

async function collectPaymentRequests(ctx: UserContext): Promise<PendingApprovalItem[]> {
  // 处理面在外部财务系统 → 站内为知情/催办堆积视图,actionable=false(不计入"你可处理")
  if (!hasAnyRole(ctx.roles, ['admin', 'finance', 'procurement', 'procurement_manager'])) return [];
  const { listPendingPaymentRequests } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { data: items, error } = await listPendingPaymentRequests();
  if (error) { console.warn('[collectPaymentRequests] failed:', error); return []; }
  return items.map((it) => ({
    id: it.id, category: 'payment_request' as ApprovalCategory,
    title: `付款申请待财务回执:${it.requestNo || it.id.slice(0, 8)}${it.amount != null ? ` · ¥${it.amount.toLocaleString()}` : ''}`,
    subtitle: '在外部财务系统处理;此处为堆积可见性',
    sourceUrl: it.poId ? `/procurement/po/${it.poId}` : '/procurement',
    createdAt: it.createdAt, ageDays: ageDaysFrom(it.createdAt), actionable: false,
  }));
}

export const CATEGORY_META: Record<ApprovalCategory, { icon: string; label: string; color: string }> = {
  delay:         { icon: '⏳',  label: '延期申请',           color: 'bg-amber-50 text-amber-700 border-amber-200' },
  amendment:     { icon: '🟣',  label: '订单修改申请',       color: 'bg-violet-50 text-violet-700 border-violet-200' },
  order_cancel:  { icon: '🛑',  label: '取消订单申请',       color: 'bg-red-50 text-red-700 border-red-200' },
  ceo_import:    { icon: '👨‍💼', label: 'CEO 批进行中订单',    color: 'bg-purple-50 text-purple-700 border-purple-200' },
  price:         { icon: '💰',  label: '价格审批',           color: 'bg-green-50 text-green-700 border-green-200' },
  agent_action:  { icon: '🤖',  label: 'Agent 建议',         color: 'bg-blue-50 text-blue-700 border-blue-200' },
  order_confirm: { icon: '📋',  label: '订单确认（4 模块）', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  payment_hold:  { icon: '💳',  label: '付款冻结',           color: 'bg-rose-50 text-rose-700 border-rose-200' },
  po_approval:   { icon: '🛒',  label: '采购单审批',         color: 'bg-orange-50 text-orange-700 border-orange-200' },
  supplement:    { icon: '➕',  label: '补采购审批',         color: 'bg-amber-50 text-amber-700 border-amber-200' },
  shipment_release: { icon: '🚢', label: '出货放行',          color: 'bg-sky-50 text-sky-700 border-sky-200' },
  baseline_over: { icon: '📈',  label: '超预算审批',         color: 'bg-red-50 text-red-700 border-red-200' },
  purpose_change: { icon: '🔁', label: '改用途审批',         color: 'bg-teal-50 text-teal-700 border-teal-200' },
  document_review: { icon: '📄', label: '单据审批',          color: 'bg-slate-50 text-slate-700 border-slate-200' },
  payment_request: { icon: '💸', label: '付款待回执',        color: 'bg-lime-50 text-lime-700 border-lime-200' },
  supplier_change: { icon: '🔀', label: '改供应商审批',       color: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
};
