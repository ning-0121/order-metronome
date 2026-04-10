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
import { revalidatePath } from 'next/cache';
import {
  parseCostSheet,
  calculateMaterialBudget,
  checkProcurementReasonability,
  checkCmtReasonability,
  type CostSheetRow,
} from '@/lib/finance/costSheetParser';

// ════════════════════════════════════════════════
// 1. 上传内部成本核算单 → 解析 → 写入基线
// ════════════════════════════════════════════════

export async function uploadCostSheet(
  orderId: string,
  file: File,
  styleNo?: string,
): Promise<{ error?: string; data?: any }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 读取 Excel
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await parseCostSheet(buffer);

  if (result.warnings.length > 0 && result.rows.length === 0) {
    return { error: '解析失败：' + result.warnings.join('; ') };
  }

  // 找到匹配当前订单款号的行（如果有多行），否则取第一行
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, style_no, quantity')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  const targetStyle = styleNo || (order as any).style_no;
  let matched = result.rows.find(r =>
    targetStyle && r.style && r.style.toLowerCase().includes(targetStyle.toLowerCase()),
  );
  if (!matched && result.rows.length > 0) {
    matched = result.rows[0]; // 兜底取第一行
  }
  if (!matched) {
    return { error: `报价单中没有找到匹配的款号（搜索：${targetStyle || '未指定'}）` };
  }

  const quantity = (order as any).quantity || 0;

  // 计算面料预算
  const consumptionKg = matched.fabric_consumption_kg || 0;
  const budget = consumptionKg > 0 && quantity > 0
    ? calculateMaterialBudget(consumptionKg, quantity, 3)
    : null;

  // 写入/更新 order_cost_baseline
  const baselineData: any = {
    order_id: orderId,
    fabric_area_m2: matched.fabric_area_m2 || null,
    fabric_weight_kg_m2: matched.fabric_weight_kg_m2 || null,
    fabric_consumption_kg: matched.fabric_consumption_kg || null,
    fabric_price_per_kg: matched.fabric_price_per_kg || null,
    waste_pct: 3,
    budget_fabric_kg: budget?.grossUsage || null,
    budget_fabric_amount: budget ? Number((budget.grossUsage * (matched.fabric_price_per_kg || 0)).toFixed(2)) : null,
    cmt_internal_estimate: matched.cmt_price || null,
    cmt_factory_quote: matched.factory_cmt_quote || null,
    cmt_labor_rate: matched.labor_rate || null,
    total_cost_per_piece: matched.total_cost || null,
    fob_price: matched.fob_price || null,
    ddp_price: matched.ddp_price || null,
    source_file_name: file.name,
    parsed_at: new Date().toISOString(),
    parsed_by: user.id,
    updated_at: new Date().toISOString(),
  };

  // Upsert（一个订单只有一条基线）
  const { data: existing } = await (supabase.from('order_cost_baseline') as any)
    .select('id')
    .eq('order_id', orderId)
    .single();

  if (existing) {
    await (supabase.from('order_cost_baseline') as any)
      .update(baselineData)
      .eq('order_id', orderId);
  } else {
    await (supabase.from('order_cost_baseline') as any).insert(baselineData);
  }

  revalidatePath(`/orders/${orderId}`);
  return {
    data: {
      style: matched.style,
      fabric_consumption_kg: matched.fabric_consumption_kg,
      cmt_price: matched.cmt_price,
      budget_kg: budget?.grossUsage,
      warnings: result.warnings,
    },
  };
}

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
    await (supabase.from('notifications') as any).insert({
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
  } catch {}
}
