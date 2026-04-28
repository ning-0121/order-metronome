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

// ── 类型 ──────────────────────────────────────────────────────

export type ApprovalCategory =
  | 'delay'           // 延期申请
  | 'ceo_import'      // CEO 待批进行中导入订单
  | 'price'           // 预订单价格审批
  | 'agent_action'    // Agent 待执行动作
  | 'order_confirm'   // 订单确认模块（面料/颜色/印花/包装）
  | 'payment_hold';   // 付款冻结

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
  const { data } = await (supabase.from('delay_requests') as any)
    .select('id, order_id, reason, days_delay, status, created_at, requested_by, orders(order_no, customer_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);

  const canApprove = hasAnyRole(ctx.roles, ['admin', 'production_manager', 'production']);

  return ((data || []) as any[]).map(r => ({
    id: r.id,
    category: 'delay' as ApprovalCategory,
    title: `${r.orders?.order_no || '?'} 申请延期 ${r.days_delay || '?'} 天`,
    subtitle: r.reason ? r.reason.slice(0, 50) : undefined,
    orderId: r.order_id,
    orderNo: r.orders?.order_no,
    customerName: r.orders?.customer_name,
    sourceUrl: `/orders/${r.order_id}#delay-${r.id}`,
    createdAt: r.created_at,
    ageDays: ageDaysFrom(r.created_at),
    actionable: canApprove,
  }));
}

async function collectCeoImportApprovals(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  // CEO 审批进行中导入订单：lifecycle_status='pending_approval'
  const { data } = await (supabase.from('orders') as any)
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
  const { data } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id, customer_name, po_number, summary, status, created_at, expires_at, requested_by')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);

  // 仅 finance / admin 可批
  const canApprove = hasAnyRole(ctx.roles, ['admin', 'finance']);

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
  const { data } = await (supabase.from('agent_actions') as any)
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
    sourceUrl: r.order_id ? `/orders/${r.order_id}` : '/admin/agent',
    createdAt: r.created_at,
    ageDays: ageDaysFrom(r.created_at),
    actionable: canApprove,
  }));
}

async function collectPaymentHolds(
  supabase: any,
  ctx: UserContext,
): Promise<PendingApprovalItem[]> {
  const { data } = await (supabase.from('order_financials') as any)
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
  // 订单确认模块（面料/颜色/印花/包装）not_started 或 pending
  // 只对 active/draft 订单关注
  const { data } = await (supabase.from('order_confirmations') as any)
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
    // 6 个数据源并行
    const [
      delays,
      ceoImports,
      prices,
      agentActions,
      paymentHolds,
      confirmations,
    ] = await Promise.all([
      collectDelayRequests(supabase, ctx).catch(e => { console.warn('[pending-approvals] delays failed:', e?.message); return []; }),
      collectCeoImportApprovals(supabase, ctx).catch(e => { console.warn('[pending-approvals] ceo failed:', e?.message); return []; }),
      collectPriceApprovals(supabase, ctx).catch(e => { console.warn('[pending-approvals] price failed:', e?.message); return []; }),
      collectAgentActions(supabase, ctx).catch(e => { console.warn('[pending-approvals] agent failed:', e?.message); return []; }),
      collectPaymentHolds(supabase, ctx).catch(e => { console.warn('[pending-approvals] hold failed:', e?.message); return []; }),
      collectOrderConfirmations(supabase, ctx).catch(e => { console.warn('[pending-approvals] confirm failed:', e?.message); return []; }),
    ]);

    const allItems = [
      ...delays, ...ceoImports, ...prices, ...agentActions, ...paymentHolds, ...confirmations,
    ];

    // 按 ageDays 倒序（卡得越久越靠前）
    allItems.sort((a, b) => b.ageDays - a.ageDays);

    const byCategory: Record<ApprovalCategory, number> = {
      delay:         delays.length,
      ceo_import:    ceoImports.length,
      price:         prices.length,
      agent_action:  agentActions.length,
      payment_hold:  paymentHolds.length,
      order_confirm: confirmations.length,
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

export const CATEGORY_META: Record<ApprovalCategory, { icon: string; label: string; color: string }> = {
  delay:         { icon: '⏳',  label: '延期申请',           color: 'bg-amber-50 text-amber-700 border-amber-200' },
  ceo_import:    { icon: '👨‍💼', label: 'CEO 批进行中订单',    color: 'bg-purple-50 text-purple-700 border-purple-200' },
  price:         { icon: '💰',  label: '价格审批',           color: 'bg-green-50 text-green-700 border-green-200' },
  agent_action:  { icon: '🤖',  label: 'Agent 建议',         color: 'bg-blue-50 text-blue-700 border-blue-200' },
  order_confirm: { icon: '📋',  label: '订单确认（4 模块）', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  payment_hold:  { icon: '💳',  label: '付款冻结',           color: 'bg-rose-50 text-rose-700 border-rose-200' },
};
