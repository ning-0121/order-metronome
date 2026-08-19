'use server';

/**
 * 财务成本控制 — 核心动作
 *
 * 1. 上传内部成本核算单 → 解析 → 写入 order_cost_baseline
 * 2. 采购校验（预算 vs 采购数量 → 标红通知）
 * 3. 成本控制面板数据
 * 4. 标红 → 通知责任人 + 财务 + CEO
 */

import { createClient } from '@/lib/supabase/server';
import { safeMutation } from '@/lib/db/safe-mutation';
import { revalidatePath } from 'next/cache';
import { calculateProfitSnapshot } from '@/lib/services/profit.service';
import {
  parseCostSheet,
  calculateMaterialBudget,
  checkProcurementReasonability,
  checkCmtReasonability,
  type CostSheetRow,
} from '@/lib/finance/costSheetParser';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { insertNotifications } from '@/lib/utils/notifications';

/** 价格红线：仅可见财务的角色能读成本数据 */
async function assertCanSeeFinancials(supabase: any, userId: string): Promise<boolean> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  return hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
}

// ── 2026-08-19 P2 决策单 B3:CostControlTab 已删(2026-07-08 弃用,成本真相走 order_cost_baseline+采购核料) ──
// 随宿主移除 tab 专属导出 uploadCostSheet / saveCostBaselineManual / autoParseExistingCostSheet;
// 保留 getCostControlSummary / sendCostAlert(milestones.ts、procurement.ts 在用的成本预警)。复活翻 git 历史。

// ════════════════════════════════════════════════
// 2. 获取订单成本控制全景
// ════════════════════════════════════════════════

export interface CostControlSummary {
  baseline: any | null;
  procurement: {
    totalOrderedKg: number;
    totalReceivedKg: number;
    budgetCheck: ReturnType<typeof checkProcurementReasonability> | null;
  };
  cmt: {
    cmtCheck: ReturnType<typeof checkCmtReasonability> | null;
  };
  alerts: Array<{
    level: 'red' | 'yellow';
    title: string;
    message: string;
  }>;
}

export async function getCostControlSummary(orderId: string): Promise<{
  data?: CostControlSummary;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await assertCanSeeFinancials(supabase, user.id))) {
    return { error: '无权查看成本数据' };
  }

  // 基线
  const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
    .select('*')
    .eq('order_id', orderId)
    .single();

  // 采购数据
  const { data: procItems } = await (supabase.from('procurement_line_items') as any)
    .select('ordered_qty, received_qty, ordered_unit, category')
    .eq('order_id', orderId)
    .eq('category', 'fabric'); // 只看面料

  const fabricItems = (procItems || []) as any[];
  const totalOrderedKg = fabricItems.reduce((s: number, i: any) => s + (i.ordered_qty || 0), 0);
  const totalReceivedKg = fabricItems
    .filter((i: any) => i.received_qty !== null)
    .reduce((s: number, i: any) => s + (i.received_qty || 0), 0);

  // 采购 vs 预算校验
  let budgetCheck = null;
  if (baseline?.budget_fabric_kg && totalOrderedKg > 0) {
    budgetCheck = checkProcurementReasonability(baseline.budget_fabric_kg, totalOrderedKg);
  }

  // 加工费校验
  let cmtCheck = null;
  if (baseline?.cmt_internal_estimate && baseline?.cmt_factory_quote) {
    cmtCheck = checkCmtReasonability(baseline.cmt_internal_estimate, baseline.cmt_factory_quote);
  }

  // 汇总警报
  const alerts: CostControlSummary['alerts'] = [];
  if (budgetCheck?.status === 'over_limit') {
    alerts.push({ level: 'red', title: '面料采购超预算', message: budgetCheck.message });
  } else if (budgetCheck?.status === 'warning') {
    alerts.push({ level: 'yellow', title: '面料采购偏差', message: budgetCheck.message });
  }
  if (cmtCheck?.status === 'over_limit') {
    alerts.push({ level: 'red', title: '加工费偏高', message: cmtCheck.message });
  } else if (cmtCheck?.status === 'warning') {
    alerts.push({ level: 'yellow', title: '加工费偏差', message: cmtCheck.message });
  }

  return {
    data: {
      baseline,
      procurement: { totalOrderedKg, totalReceivedKg, budgetCheck },
      cmt: { cmtCheck },
      alerts,
    },
  };
}

// ════════════════════════════════════════════════
// 3. 标红通知（责任人 + 财务 + CEO）
// ════════════════════════════════════════════════

/**
 * 当成本控制出现标红时，通知三方：
 *   - 责任人（节点 owner）
 *   - 所有 finance 角色
 *   - 所有 admin（CEO）
 */
export async function sendCostAlert(
  orderId: string,
  alertType: 'procurement_over_budget' | 'cmt_over_estimate',
  message: string,
  responsibleUserId?: string,
): Promise<void> {
  const supabase = await createClient();
  // P2 修:原完全无鉴权 → 任意人可对任意订单向财务/CEO 发通知+企微(骚扰面)。至少要求登录
  // (内部合法调用方=采购/生产/财务的已鉴权 action,都有会话,不受影响)。
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name')
    .eq('id', orderId)
    .single();
  const orderNo = (order as any)?.order_no || '?';
  const customer = (order as any)?.customer_name || '?';

  const title =
    alertType === 'procurement_over_budget'
      ? `🔴 ${orderNo} 面料采购超预算 — ${customer}`
      : `🔴 ${orderNo} 加工费异常 — ${customer}`;

  // 找通知对象：责任人 + finance + admin
  const { data: profiles } = await (supabase.from('profiles') as any)
    .select('user_id, role, roles');

  const recipientIds = new Set<string>();

  // 责任人
  if (responsibleUserId) recipientIds.add(responsibleUserId);

  // 财务 + CEO
  for (const p of (profiles || []) as any[]) {
    const roles: string[] = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role].filter(Boolean);
    if (roles.includes('finance') || roles.includes('admin')) {
      recipientIds.add(p.user_id);
    }
  }

  // 发通知
  for (const userId of recipientIds) {
    await insertNotifications({
      user_id: userId,
      type: 'cost_alert',
      title,
      message,
      related_order_id: orderId,
      status: 'unread',
    });
  }

  // 微信推送
  try {
    const { pushToUsers } = await import('@/lib/utils/wechat-push');
    await pushToUsers(supabase, Array.from(recipientIds), title, message).catch(() => {});
  } catch (e: any) { console.warn(`[cost-control] 成本控制次要操作:`, e?.message); }
}

