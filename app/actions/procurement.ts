'use server';

/**
 * 采购对账 — 订购 vs 实收 → 差异分析 → Excel 对账单
 *
 * 流程：
 *   采购下单时 → 录入/导入订购明细（物料名、数量、单价、供应商）
 *   原辅料到货时 → 跟单录入实收数量
 *   系统自动计算差异 → 标红偏差 >3%
 *   财务导出对账单 Excel → 发给供应商对账
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  isValidLineTransition,
  LINE_STATUS_LABELS,
  CHASE_ESCALATION_THRESHOLD,
  ACTIVE_LINE_STATUSES,
  overReceiptCheck,
  type ProcurementLineStatus,
} from '@/lib/domain/procurement';

/** 超量收货 → 通知全体财务(三个收货入口共用)。fire-and-forget,失败不影响拦截。 */
async function notifyFinanceOverReceipt(supabase: any, line: any, gate: { ordered: number; projected: number; cap: number }) {
  try {
    const { data: order } = await (supabase.from('orders') as any).select('order_no, internal_order_no').eq('id', line.order_id).maybeSingle();
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, role, roles');
    const fin = (profs || []).filter((p: any) => { const rs = p.roles?.length ? p.roles : [p.role]; return rs.includes('finance'); });
    if (fin.length) await (supabase.from('notifications') as any).insert(fin.map((f: any) => ({
      user_id: f.user_id, type: 'over_receipt',
      title: `⚠ 超量收货待处理:${order?.internal_order_no || order?.order_no || ''}`,
      message: `「${line.material_name || ''}」累计收货 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。请裁决:审批放行 / 退回布行 / 布行补足 / 超出搁置。`,
      related_order_id: line.order_id,
    })));
  } catch { /* 通知失败不影响拦截 */ }
}
import { isAdminRole, hasRoleInGroup } from '@/lib/domain/roles';
import { maskFloorForLines } from '@/lib/procurement/purchaseOrder';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { fetchLineCostsByIds } from '@/lib/procurement/floorCosts';

export interface ProcurementLineItem {
  id: string;
  order_id: string;
  material_name: string;
  material_code: string | null;
  specification: string | null;
  supplier_name: string | null;
  category: string;
  ordered_qty: number;
  ordered_unit: string;
  unit_price: number | null;
  ordered_amount: number | null;
  ordered_by: string | null;
  ordered_at: string | null;
  received_qty: number | null;
  received_unit: string | null;
  received_at: string | null;
  received_by: string | null;
  difference_qty: number | null;
  difference_pct: number | null;
  difference_amount: number | null;
  status: string;
  notes: string | null;
}

// TODO(Sprint-1): 此清单与 lib/domain/roles.ts 任一现成 group 都不完全等价（缺 sales 的 group 没有，
//                 含 production_manager 的 EXECUTION 没有 finance/sales）。
//                 保留本地常量，待评估后整合到 ROLE_GROUPS（建议命名 CAN_VIEW_PROCUREMENT）。
const ALLOWED_ROLES = ['admin', 'sales', 'merchandiser', 'finance', 'procurement', 'production_manager'];

async function checkAccess(): Promise<{ ok: boolean; userId?: string; roles?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ALLOWED_ROLES.includes(r))) return { ok: false, error: '无权限' };
  return { ok: true, userId: user.id, roles };
}

/**
 * 获取订单的采购明细
 */
export async function getProcurementItems(orderId: string): Promise<{
  data?: ProcurementLineItem[];
  error?: string;
  summary?: {
    totalOrdered: number;
    totalReceived: number;
    totalDifference: number;
    itemCount: number;
    discrepancyCount: number;
  };
}> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };
  const canSeeFloor = hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR');

  const supabase = await createClient();
  // 价列已列级封锁 → 改走 service-role 读全列(免枚举/漏列);service-role 绕过 RLS,
  // 故先补订单级鉴权,再读;非 floor 角色的底价由下方 maskFloorForLines 剥离。
  if (!(await canUserAccessOrder(supabase, auth.userId, orderId)))
    return { error: '无权查看此订单的采购信息' };
  const { data, error } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { error: error.message };

  const rawItems = (data || []) as ProcurementLineItem[];

  // 汇总(用原始底价算,但对非底价角色不返回金额)
  const totalOrdered = rawItems.reduce((s, i) => s + (i.ordered_amount || 0), 0);
  const totalReceived = rawItems
    .filter(i => i.received_qty !== null)
    .reduce((s, i) => s + ((i.received_qty || 0) * (i.unit_price || 0)), 0);
  const totalDifference = rawItems.reduce((s, i) => s + (i.difference_amount || 0), 0);
  const discrepancyCount = rawItems.filter(
    i => i.received_qty !== null && Math.abs(i.difference_pct || 0) > 3,
  ).length;

  // 底价剥离(红线③):非可见底价角色 → 剥 unit_price/金额;汇总金额也归零
  const items = maskFloorForLines(rawItems as any[], canSeeFloor) as ProcurementLineItem[];

  return {
    data: items,
    summary: {
      totalOrdered: canSeeFloor ? Number(totalOrdered.toFixed(2)) : 0,
      totalReceived: canSeeFloor ? Number(totalReceived.toFixed(2)) : 0,
      totalDifference: canSeeFloor ? Number(totalDifference.toFixed(2)) : 0,
      itemCount: rawItems.length,
      discrepancyCount,
    },
  };
}

/**
 * 添加采购明细行（采购下单时）
 */
export async function addProcurementItem(
  orderId: string,
  item: {
    material_name: string;
    material_code?: string;
    specification?: string;
    supplier_name?: string;
    category?: string;
    ordered_qty: number;
    ordered_unit?: string;
    unit_price?: number;
    qty_per_piece?: number; // 辅料：每件产品用多少（标签 2 个/件、拉链 1 条/件）
  },
): Promise<{ error?: string; data?: ProcurementLineItem }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };
  // 泄价红线③同源:执行层增行/手填底价仅限采购角色(业务执行走「补数量申请」)
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { error: '仅采购/采购经理/管理员可编辑采购执行层(业务执行请走「补数量申请」)' };

  const supabase = await createClient();

  // 预算计算 — 分面料和辅料两种逻辑
  // P0-5 修复：orderQuantity 初始为 0 而非 null，避免 TS18047 'possibly null' 警告
  // 业务上"未计算"和"数量=0"等价（未传 quantity 字段当作 0 处理）
  let budgetQty: number | null = null;
  let orderQuantity: number = 0;
  let budgetWarning: string | null = null;

  const { data: order } = await (supabase.from('orders') as any)
    .select('quantity, order_no').eq('id', orderId).single();
  orderQuantity = (order as any)?.quantity || 0;
  const orderNo = (order as any)?.order_no || '?';

  // 辅料：单件用量 × 订单数量 × 1.03 损耗
  if (item.qty_per_piece && item.qty_per_piece > 0 && orderQuantity > 0) {
    budgetQty = Number((item.qty_per_piece * orderQuantity * 1.03).toFixed(2));
  }

  // 面料：从成本基线读取预算
  if (item.category === 'fabric' || (!item.category && !item.qty_per_piece)) {
    const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
      .select('budget_fabric_kg').eq('order_id', orderId).maybeSingle();

    if (baseline?.budget_fabric_kg) {
      // 查已有面料采购总量
      const { data: existingFabric } = await (supabase.from('procurement_line_items') as any)
        .select('ordered_qty').eq('order_id', orderId).eq('category', 'fabric');
      const existingTotal = (existingFabric || []).reduce((s: number, r: any) => s + (r.ordered_qty || 0), 0);
      const newTotal = existingTotal + item.ordered_qty;
      budgetQty = baseline.budget_fabric_kg;

      const overPct = ((newTotal - budgetQty) / budgetQty) * 100;
      if (overPct > 10) {
        budgetWarning = `🔴 面料采购累计 ${newTotal.toFixed(1)} KG，超出预算 ${budgetQty.toFixed(1)} KG 的 ${overPct.toFixed(1)}%`;
      } else if (overPct > 5) {
        budgetWarning = `🟡 面料采购累计 ${newTotal.toFixed(1)} KG，超出预算 ${budgetQty.toFixed(1)} KG 的 ${overPct.toFixed(1)}%（注意控制）`;
      }
    }
  }

  // insert 后 .select('*') 返回价列 → 经 service-role(本函数已 CAN_EDIT_PROCUREMENT_EXEC 门禁)
  const { data, error } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .insert({
      order_id: orderId,
      material_name: item.material_name,
      material_code: item.material_code || null,
      specification: item.specification || null,
      supplier_name: item.supplier_name || null,
      category: item.category || 'fabric',
      ordered_qty: item.ordered_qty,
      ordered_unit: item.ordered_unit || 'KG',
      unit_price: item.unit_price || null,
      qty_per_piece: item.qty_per_piece || null,
      order_quantity: orderQuantity,
      budget_qty: budgetQty,
      ordered_by: auth.userId,
      ordered_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) return { error: error.message };

  // 自动告警：超预算时通知财务+CEO
  const shouldAlert = budgetWarning ||
    (budgetQty && item.ordered_qty > budgetQty * 1.05);

  if (shouldAlert) {
    try {
      const { sendCostAlert } = await import('@/app/actions/cost-control');
      const alertMsg = budgetWarning ||
        `${orderNo}: ${item.material_name} 采购 ${item.ordered_qty} ${item.ordered_unit || ''} 超出预算 ${budgetQty}（+${(((item.ordered_qty - (budgetQty || 0)) / (budgetQty || 1)) * 100).toFixed(1)}%）`;
      await sendCostAlert(orderId, 'procurement_over_budget', alertMsg, auth.userId);
    } catch (e: any) { console.warn(`[procurement] 采购次要操作 200:`, e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  return { data: data as ProcurementLineItem, warning: budgetWarning || undefined };
}

/**
 * 批量添加采购明细（从表格粘贴）
 */
export async function batchAddProcurementItems(
  orderId: string,
  items: Array<{
    material_name: string;
    material_code?: string;
    specification?: string;
    supplier_name?: string;
    category?: string;
    ordered_qty: number;
    ordered_unit?: string;
    unit_price?: number;
  }>,
): Promise<{ error?: string; count?: number }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };
  // 泄价红线③同源:批量增执行层含价行仅限采购角色
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { error: '仅采购/采购经理/管理员可编辑采购执行层' };

  const supabase = await createClient();
  const rows = items.map(item => ({
    order_id: orderId,
    material_name: item.material_name,
    material_code: item.material_code || null,
    specification: item.specification || null,
    supplier_name: item.supplier_name || null,
    category: item.category || 'fabric',
    ordered_qty: item.ordered_qty,
    ordered_unit: item.ordered_unit || 'KG',
    unit_price: item.unit_price || null,
    ordered_by: auth.userId,
    ordered_at: new Date().toISOString(),
  }));

  const { error } = await (supabase.from('procurement_line_items') as any).insert(rows);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return { count: rows.length };
}

/**
 * 从采购进度（procurement_tracking）同步到对账明细
 * 将采购进度里的条目转为对账明细的"订购数量"，跳过已存在的物料名（去重）
 */
export async function syncFromProcurementTracking(
  orderId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { added: 0, skipped: 0, error: auth.error };
  // 泄价红线③同源:同步进执行层含价行仅限采购角色
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { added: 0, skipped: 0, error: '仅采购/采购经理/管理员可编辑采购执行层' };

  const supabase = await createClient();

  // 只有跟单/采购/管理员可以同步
  const { data: profile } = await supabase
    .from('profiles')
    .select('roles')
    .eq('id', auth.userId)
    .maybeSingle();
  const roles: string[] = (profile as any)?.roles || [];
  const canSync = roles.some(r => ['merchandiser', 'procurement', 'admin'].includes(r));
  if (!canSync) return { added: 0, skipped: 0, error: '仅跟单/采购/管理员可同步' };

  // 取采购进度里的条目
  const { data: tracking, error: tErr } = await (supabase.from('procurement_tracking') as any)
    .select('item_name, supplier, quantity, category, notes')
    .eq('order_id', orderId)
    .eq('is_supplement', false)
    .not('quantity', 'is', null);
  if (tErr) return { added: 0, skipped: 0, error: tErr.message };
  if (!tracking || tracking.length === 0) return { added: 0, skipped: 0, error: '采购进度里暂无数据' };

  // 取已有对账明细（去重用）
  const { data: existing } = await (supabase.from('procurement_line_items') as any)
    .select('material_name')
    .eq('order_id', orderId);
  const existingNames = new Set((existing || []).map((e: any) => e.material_name));

  const CATEGORY_MAP: Record<string, string> = {
    fabric: 'fabric', trims: 'trim', packaging: 'packing', other: 'other',
  };

  const toInsert = (tracking as any[])
    .filter(t => !existingNames.has(t.item_name))
    .map(t => ({
      order_id: orderId,
      material_name: t.item_name,
      supplier_name: t.supplier || null,
      category: CATEGORY_MAP[t.category] || 'other',
      ordered_qty: Number(t.quantity) || 0,
      ordered_unit: 'KG',
      notes: t.notes || null,
      ordered_by: auth.userId,
      ordered_at: new Date().toISOString(),
    }));

  const skipped = tracking.length - toInsert.length;
  if (toInsert.length === 0) return { added: 0, skipped, error: '所有采购进度条目已存在于对账明细中' };

  const { error: iErr } = await (supabase.from('procurement_line_items') as any).insert(toInsert);
  if (iErr) return { added: 0, skipped, error: iErr.message };

  revalidatePath(`/orders/${orderId}`);
  return { added: toInsert.length, skipped };
}

/**
 * 录入实收数据（原辅料到货时）
 */
export async function recordReceipt(
  itemId: string,
  orderId: string,
  receivedQty: number,
  notes?: string,
  allowOver = false,
): Promise<{ error?: string; needsApproval?: boolean }> {
  // O4(2026-07-02 审计):收货是库存动作,收紧到操作角色(采购/管理员),
  // 与 recordGoodsReceipt 同一门槛;此前用 checkAccess 让 sales/finance 也能记收货。
  const auth = await checkOperator();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();

  // 获取原始订购数据
  const { data: item } = await (supabase.from('procurement_line_items') as any)
    .select('ordered_qty, ordered_unit')
    .eq('id', itemId)
    .single();
  if (!item) return { error: '明细不存在' };

  // 收货 ±10% 硬闸(此入口为覆盖写=总量,故 prev=0、thisQty=总量;超量拦截通知财务)
  if (receivedQty > 0) {
    const gate = overReceiptCheck((item as any).ordered_qty, 0, receivedQty);
    if (gate.over) {
      const isFinance = auth.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!allowOver) {
        await notifyFinanceOverReceipt(supabase, { order_id: orderId, material_name: null, ordered_unit: (item as any).ordered_unit }, gate);
        return { error: `⚠ 收货 ${gate.projected}${(item as any).ordered_unit || ''} 超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务:审批放行 / 退回布行 / 布行补足 / 超出搁置。超量请走「收货登记」批次录入由财务放行。`, needsApproval: true };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行' };
    }
  }

  // 判断状态（旧 status 列 + 同步新 line_status，否则采购中心队列会永远显示在途/待催）
  let status = 'complete';
  let lineStatus = 'accepted';        // 收齐/超发 → 验收通过，移出所有在途队列
  const diff = receivedQty - (item as any).ordered_qty;
  if (receivedQty === 0) { status = 'cancelled'; lineStatus = 'cancelled'; }
  else if (diff < -((item as any).ordered_qty * 0.03)) { status = 'partial'; lineStatus = 'arrived'; } // 短缺>3% → 进待验收
  else if (diff > (item as any).ordered_qty * 0.03) { status = 'over'; lineStatus = 'accepted'; }      // 超发>3%

  const { error } = await (supabase.from('procurement_line_items') as any)
    .update({
      received_qty: receivedQty,
      received_unit: (item as any).ordered_unit,
      received_at: new Date().toISOString(),
      received_by: auth.userId,
      status,
      line_status: lineStatus,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { error: error.message };

  // W0: 采购收货 → 自动入库(增量 delta)。fire-and-forget，不阻断收货主流程。
  try {
    const { recordInventoryReceipt } = await import('@/app/actions/inventory');
    await recordInventoryReceipt(itemId);
  } catch (e: any) { console.warn('[recordReceipt] 自动入库失败(不阻断收货,库存可能滞后):', e?.message); }

  // B3a: 收货 → 联动关联采购项收货状态(fire-and-forget)。
  try {
    const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items');
    await syncProcurementItemReceivingStatus(orderId);
  } catch (e: any) { console.warn('[recordReceipt] 采购项状态联动失败(不阻断收货):', e?.message); }

  // 到货校验：实收 vs 预算（如果有预算的话）
  const { data: fullItem } = await (supabase.from('procurement_line_items') as any)
    .select('budget_qty, material_name, ordered_unit, order_id')
    .eq('id', itemId)
    .single();
  if (fullItem?.budget_qty && Math.abs(receivedQty - fullItem.budget_qty) / fullItem.budget_qty > 0.05) {
    try {
      const { sendCostAlert } = await import('@/app/actions/cost-control');
      const { data: order } = await (supabase.from('orders') as any)
        .select('order_no').eq('id', orderId).single();
      const pct = (((receivedQty - fullItem.budget_qty) / fullItem.budget_qty) * 100).toFixed(1);
      await sendCostAlert(
        orderId,
        'procurement_over_budget',
        `${order?.order_no || '?'}: ${fullItem.material_name} 实收 ${receivedQty} ${fullItem.ordered_unit || ''} vs 预算 ${fullItem.budget_qty}（偏差 ${pct}%）`,
        auth.userId,
      );
    } catch (e: any) { console.warn(`[procurement] 采购次要操作 372:`, e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 删除采购明细行
 */
export async function deleteProcurementItem(
  itemId: string,
  orderId: string,
): Promise<{ error?: string }> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  // 泄价红线③同源:执行层删行仅限采购角色
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { error: '仅采购/采购经理/管理员可编辑采购执行层' };

  const supabase = await createClient();
  const { error } = await (supabase.from('procurement_line_items') as any)
    .delete()
    .eq('id', itemId);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 导出对账单 Excel（给财务发给供应商）
 */
export async function exportReconciliationSheet(orderId: string): Promise<{
  error?: string;
  base64?: string;
  fileName?: string;
}> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  // 对账单含底价/金额,仅可见底价角色可导出(业务/生产不得导出含价对账单)
  if (!hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR'))
    return { error: '仅采购/财务/管理员可导出含价对账单' };

  const supabase = await createClient();

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, factory_name, internal_order_no')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 获取采购明细(含底价 → 已列级封锁,经 service-role 读;本函数已 CAN_SEE_PROCUREMENT_FLOOR 门禁)
  const { data: items } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category')
    .order('created_at');

  if (!items || items.length === 0) return { error: '暂无采购明细' };

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'QIMO OS';
  const ws = wb.addWorksheet('采购对账单', { views: [{ state: 'frozen', ySplit: 3 }] });

  // 标题
  ws.mergeCells('A1:K1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `采购对账单 — ${(order as any).order_no} · ${(order as any).customer_name || ''}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // 副标题
  ws.mergeCells('A2:K2');
  ws.getCell('A2').value = `工厂：${(order as any).factory_name || '—'} · 内部单号：${(order as any).internal_order_no || '—'} · 导出时间：${new Date().toLocaleDateString('zh-CN')}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF6B7280' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };

  // 表头
  const headers = ['物料名称', '规格', '供应商', '类别', '订购数量', '单位', '单价', '订购金额', '实收数量', '差异', '差异%'];
  const headerRow = ws.getRow(3);
  headerRow.values = headers;
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
  });

  // 数据
  const CATEGORY_LABELS: Record<string, string> = {
    fabric: '面料', lining: '里料', trim: '辅料', label: '标签',
    zipper: '拉链', button: '纽扣', elastic: '松紧', packing: '包材', other: '其他',
  };

  let totalOrderedAmt = 0;
  let totalReceivedAmt = 0;

  (items as any[]).forEach((item, i) => {
    const row = ws.getRow(i + 4);
    const receivedAmt = (item.received_qty || 0) * (item.unit_price || 0);
    totalOrderedAmt += item.ordered_amount || 0;
    totalReceivedAmt += receivedAmt;

    row.values = [
      item.material_name,
      item.specification || '',
      item.supplier_name || '',
      CATEGORY_LABELS[item.category] || item.category,
      item.ordered_qty,
      item.ordered_unit || 'KG',
      item.unit_price || '',
      item.ordered_amount || '',
      item.received_qty ?? '未收',
      item.difference_qty ?? '',
      item.difference_pct !== null ? `${item.difference_pct}%` : '',
    ];

    // 差异标红
    if (item.received_qty !== null && Math.abs(item.difference_pct || 0) > 3) {
      row.getCell(10).font = { bold: true, color: { argb: 'FFDC2626' } };
      row.getCell(11).font = { bold: true, color: { argb: 'FFDC2626' } };
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      });
    }

    row.eachCell(cell => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFF3F4F6' } },
      };
    });
  });

  // 合计行
  const totalRow = ws.getRow(items.length + 4);
  totalRow.values = ['合计', '', '', '', '', '', '', totalOrderedAmt.toFixed(2), '', (totalReceivedAmt - totalOrderedAmt).toFixed(2), ''];
  totalRow.font = { bold: true };
  totalRow.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

  // 列宽
  [18, 16, 14, 8, 10, 6, 8, 12, 10, 10, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const fileName = `对账单_${(order as any).order_no}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return { base64, fileName };
}

// ════════════════════════════════════════════════════════════
// 采购中心 V1 — 行级状态机 + 催货（契约：docs/procurement-center-design.md §4/§11）
// ════════════════════════════════════════════════════════════

/** 可操作采购行流转的角色（查看权限沿用上方 ALLOWED_ROLES，更宽） */
const OPERATOR_ROLES = ['procurement', 'admin', 'admin_assistant'];

async function checkOperator(): Promise<{ ok: boolean; userId?: string; roles?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles) && !roles.some(r => OPERATOR_ROLES.includes(r))) {
    return { ok: false, error: '无权限：仅采购/管理员可操作采购行' };
  }
  return { ok: true, userId: user.id, roles };
}

/** 让步接收审批权（决策3）。procurement_manager 角色注册后自动生效，当前仅 admin。 */
function canApproveConcession(roles: string[]): boolean {
  return isAdminRole(roles) || roles.includes('procurement_manager');
}

/** 采购操作日志（复制 milestone_logs 模式：失败不阻断主流程，但要冒出来） */
async function logProcurement(
  supabase: any, lineItemId: string, orderId: string, action: string,
  fromStatus: string | null, toStatus: string | null, note?: string | null, payload?: any,
) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await (supabase.from('procurement_logs') as any).insert({
    line_item_id: lineItemId, order_id: orderId, actor_user_id: user?.id ?? null,
    action, from_status: fromStatus, to_status: toStatus,
    note: note || null, payload: payload || null,
  });
  if (error) console.error('[procurement] log insert failed:', error.message);
}

/** 历史中位价（同物料名，全供应商）。无样本返回 null。 */
async function medianHistoricalPrice(supabase: any, materialName: string): Promise<number | null> {
  const { data, error } = await (supabase.from('price_history') as any)
    .select('unit_price').eq('material_name', materialName)
    .order('quoted_at', { ascending: false }).limit(50);
  if (error) { console.error('[procurement] price_history read failed:', error.message); return null; }
  const prices = (data || []).map((r: any) => Number(r.unit_price)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

export interface TransitionPayload {
  po_no?: string;
  unit_price?: number;
  promised_date?: string;     // YYYY-MM-DD
  expected_arrival?: string;  // YYYY-MM-DD
  supplier_id?: string;
  supplier_name?: string;
  note?: string;
}

/**
 * 采购行状态流转（唯一入口）。
 * 规则：状态机校验（lib/domain/procurement）；cancelled 必填理由；
 *       concession 仅 procurement_manager/admin（决策3）；
 *       → ordered 时写价格快照（price_baseline=历史中位价）+ price_history（决策4：只记录不阻断）。
 */
export async function transitionProcurementLine(
  lineItemId: string,
  nextStatus: ProcurementLineStatus,
  payload?: TransitionPayload,
): Promise<{ data?: any; error?: string }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();
  // 读/写含底价列 → 经 service-role(本函数已 checkOperator=采购/admin 门禁,允许看价)
  const svc = createServiceRoleClient();

  const { data: line, error: getErr } = await (svc.from('procurement_line_items') as any)
    .select('id, order_id, line_status, material_name, specification, category, supplier_id, supplier_name, unit_price, ordered_unit, ordered_qty')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  const fromStatus = (line.line_status || 'draft') as ProcurementLineStatus;
  if (!isValidLineTransition(fromStatus, nextStatus)) {
    return { error: `不允许从「${LINE_STATUS_LABELS[fromStatus] || fromStatus}」转到「${LINE_STATUS_LABELS[nextStatus] || nextStatus}」` };
  }
  if (nextStatus === 'cancelled' && !payload?.note?.trim()) {
    return { error: '取消采购行必须填写理由' };
  }
  if (nextStatus === 'concession' && !canApproveConcession(access.roles || [])) {
    return { error: '让步接收需采购经理或管理员审批' };
  }

  const now = new Date().toISOString();
  const update: Record<string, any> = { line_status: nextStatus, updated_at: now };
  if (payload?.promised_date !== undefined) update.promised_date = payload.promised_date || null;
  if (payload?.expected_arrival !== undefined) update.expected_arrival = payload.expected_arrival || null;
  if (payload?.supplier_id !== undefined) update.supplier_id = payload.supplier_id || null;
  if (payload?.supplier_name !== undefined) update.supplier_name = payload.supplier_name || null;

  let priceSnapshotNote: string | null = null;
  if (nextStatus === 'ordered') {
    update.ordered_at = now;
    update.ordered_by = access.userId;
    if (payload?.po_no !== undefined) update.po_no = payload.po_no || null;
    if (payload?.unit_price !== undefined && payload.unit_price !== null) {
      update.unit_price = payload.unit_price;
      // 价格快照：基线=历史中位价（决策4：V1 只标色提醒，不阻断）
      const baseline = await medianHistoricalPrice(supabase, line.material_name);
      if (baseline !== null) update.price_baseline = baseline;
      priceSnapshotNote = baseline !== null
        ? `价格快照：本次 ${payload.unit_price}，历史中位 ${baseline}`
        : `价格快照：本次 ${payload.unit_price}，无历史基线（首单）`;
    }
  }
  if (nextStatus === 'confirmed') update.confirmed_at = now;
  if (nextStatus === 'shipped') update.shipped_at = now;

  const { data: updated, error: upErr } = await (svc.from('procurement_line_items') as any)
    .update(update).eq('id', lineItemId).select().single();
  if (upErr) return { error: upErr.message };

  // → ordered 且有单价：写价格库（自动沉淀；失败不阻断但记日志）
  if (nextStatus === 'ordered' && payload?.unit_price) {
    const { error: phErr } = await (supabase.from('price_history') as any).insert({
      order_id: line.order_id, line_item_id: lineItemId,
      supplier_id: payload.supplier_id ?? line.supplier_id ?? null,
      material_name: line.material_name, specification: line.specification ?? null,
      category: line.category ?? null,
      unit_price: payload.unit_price, unit: line.ordered_unit ?? null,
      qty: line.ordered_qty ?? null, quoted_at: now, source: 'order',
    });
    if (phErr) console.error('[procurement] price_history insert failed:', phErr.message);
  }

  await logProcurement(supabase, lineItemId, line.order_id, 'status_transition',
    fromStatus, nextStatus, payload?.note ?? priceSnapshotNote,
    { po_no: payload?.po_no, unit_price: payload?.unit_price, promised_date: payload?.promised_date, expected_arrival: payload?.expected_arrival });

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { data: updated };
}

/**
 * 催货留痕：chase_count+1 + last_chased_at + 日志；
 * 达到 CHASE_ESCALATION_THRESHOLD 的整数倍 → 通知管理员（procurement_manager 角色注册后改发 PM）。
 */
export async function chaseProcurementLine(
  lineItemId: string, note?: string,
): Promise<{ data?: { chase_count: number }; error?: string }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();

  const { data: line, error: getErr } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, chase_count, material_name, supplier_name')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  if (!ACTIVE_LINE_STATUSES.includes(line.line_status as ProcurementLineStatus)) {
    return { error: `仅在途行可催货（当前：${LINE_STATUS_LABELS[line.line_status as ProcurementLineStatus] || line.line_status}）` };
  }

  const newCount = (line.chase_count || 0) + 1;
  const { error: upErr } = await (supabase.from('procurement_line_items') as any)
    .update({ chase_count: newCount, last_chased_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', lineItemId);
  if (upErr) return { error: upErr.message };

  await logProcurement(supabase, lineItemId, line.order_id, 'chase', null, null,
    note || `第 ${newCount} 次催货`, { chase_count: newCount });

  // 升级：3 次（及其倍数）无果 → 通知管理员
  if (newCount >= CHASE_ESCALATION_THRESHOLD && newCount % CHASE_ESCALATION_THRESHOLD === 0) {
    try {
      const { data: admins } = await (supabase.from('profiles') as any)
        .select('user_id').or('role.eq.admin,roles.cs.{admin}');
      for (const a of admins || []) {
        await (supabase.from('notifications') as any).insert({
          user_id: a.user_id,
          type: 'procurement_chase_escalation',
          title: `⚠️ 催货 ${newCount} 次未果：${line.material_name}`,
          message: `供应商「${line.supplier_name || '未填'}」的「${line.material_name}」已催 ${newCount} 次仍未推进，请介入。`,
          related_order_id: line.order_id,
        });
      }
    } catch (e: any) {
      console.error('[procurement] chase escalation notify failed:', e?.message);
    }
  }

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { data: { chase_count: newCount } };
}

/**
 * 到货验收：写 goods_receipts + 流转采购行（决策3：让步仅 PM/admin）。
 * result: 'pass'→accepted / 'concession'→concession / 'reject'→rejected。
 * arrived→accepted/concession/rejected 走状态机校验（lib/domain）。
 */
export async function recordGoodsReceipt(
  lineItemId: string,
  payload: {
    received_qty: number;
    received_unit?: string;
    result: 'pass' | 'concession' | 'reject';
    aql_level?: string;
    defect_notes?: string;
    return_required?: boolean;
    allow_over?: boolean;
  },
): Promise<{ error?: string; needsApproval?: boolean; cap?: number }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();

  const { data: line, error: getErr } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, ordered_unit, ordered_qty, material_name')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  const nextStatus = payload.result === 'pass' ? 'accepted'
    : payload.result === 'concession' ? 'concession' : 'rejected';
  if (!isValidLineTransition(line.line_status, nextStatus as ProcurementLineStatus)) {
    return { error: `仅「已到厂」可验收（当前：${LINE_STATUS_LABELS[line.line_status as ProcurementLineStatus] || line.line_status}）` };
  }
  if (payload.result === 'concession' && !canApproveConcession(access.roles || [])) {
    return { error: '让步接收需采购经理或管理员审批' };
  }
  if (!(payload.received_qty >= 0)) return { error: '实收数量无效' };

  // 收货 ±10% 硬闸(与批次收货同口径;拒收 result=reject 不计超收——本就是不入账退货)
  if (payload.result !== 'reject') {
    const { data: prev } = await (supabase.from('goods_receipts') as any)
      .select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject');
    const prevTotal = ((prev || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
    const gate = overReceiptCheck(line.ordered_qty, prevTotal, payload.received_qty);
    if (gate.over) {
      const isFinance = access.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!payload.allow_over) {
        await notifyFinanceOverReceipt(supabase, line, gate);
        return { error: `⚠ 验收累计 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务:审批放行 / 退回布行 / 布行补足 / 超出搁置。`, needsApproval: true, cap: gate.cap };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行' };
    }
  }

  const now = new Date().toISOString();
  const { error: grErr } = await (supabase.from('goods_receipts') as any).insert({
    line_item_id: lineItemId, order_id: line.order_id,
    received_qty: payload.received_qty,
    received_unit: payload.received_unit || line.ordered_unit || null,
    received_by: access.userId,
    inspection_result: payload.result === 'pass' ? 'pass' : payload.result === 'concession' ? 'concession' : 'reject',
    aql_level: payload.aql_level || null,
    defect_notes: payload.defect_notes || null,
    concession_approved_by: payload.result === 'concession' ? access.userId : null,
    return_required: payload.result === 'reject' ? (payload.return_required ?? true) : false,
    return_status: payload.result === 'reject' ? 'pending' : null,
  });
  if (grErr) return { error: grErr.message };

  // 汇总该行已验收数量，回写 received_qty
  const { data: receipts } = await (supabase.from('goods_receipts') as any)
    .select('received_qty').eq('line_item_id', lineItemId);
  const totalReceived = (receipts || []).reduce((s: number, r: any) => s + (Number(r.received_qty) || 0), 0);

  const { error: upErr } = await (supabase.from('procurement_line_items') as any)
    .update({ line_status: nextStatus, received_qty: totalReceived, received_at: now, received_by: access.userId, updated_at: now })
    .eq('id', lineItemId);
  if (upErr) return { error: upErr.message };

  // W1: QC 验收也自动入库(增量 delta,与 recordReceipt 同函数,补挂不双计)。
  try {
    const { recordInventoryReceipt } = await import('@/app/actions/inventory');
    await recordInventoryReceipt(lineItemId);
  } catch (e: any) { console.warn('[recordGoodsReceipt] 自动入库失败(不阻断验收,库存可能滞后):', e?.message); }

  // B3a: QC 验收 → 联动关联采购项收货状态(fire-and-forget)。
  try {
    const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items');
    await syncProcurementItemReceivingStatus(line.order_id);
  } catch (e: any) { console.warn('[recordGoodsReceipt] 采购项状态联动失败(不阻断验收):', e?.message); }

  await logProcurement(supabase, lineItemId, line.order_id, 'inspect',
    line.line_status, nextStatus,
    `验收 ${payload.result === 'pass' ? '通过' : payload.result === 'concession' ? '让步接收' : '拒收'}：实收 ${payload.received_qty}${payload.defect_notes ? '，' + payload.defect_notes : ''}`,
    { result: payload.result, received_qty: payload.received_qty, aql: payload.aql_level });

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return {};
}

/**
 * 收货登记(分时间分批次)—— 每批追加 goods_receipts 一行,自动汇总回写 received_qty,
 * 未收齐留在「待验收」可继续录下一批,收齐(或勾"收齐")→ accepted 离队。码单存 order-docs(photos jsonb)。
 * 与 recordGoodsReceipt(QC 让步/拒收)分工:本函数=实收入账的日常收货。
 */
export async function recordReceiptBatch(
  lineItemId: string,
  payload: { received_qty: number; received_date?: string; slip_paths?: string[]; note?: string; mark_complete?: boolean; allow_over?: boolean },
): Promise<{ error?: string; ok?: boolean; total_received?: number; ordered?: number; complete?: boolean; needsApproval?: boolean; cap?: number }> {
  const access = await checkOperator();
  if (!access.ok || !access.userId) return { error: access.error };
  if (!(payload.received_qty > 0)) return { error: '本批实收数量必须大于 0' };
  const supabase = await createClient();

  const { data: line } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, ordered_qty, ordered_unit, received_qty, material_name').eq('id', lineItemId).single();
  if (!line) return { error: '采购行不存在' };

  const now = new Date().toISOString();

  // ── 收货 ±10% 硬闸(统一纯函数 overReceiptCheck)──
  {
    const { data: prev } = await (supabase.from('goods_receipts') as any).select('received_qty').eq('line_item_id', lineItemId);
    const prevTotal = ((prev || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
    const gate = overReceiptCheck(line.ordered_qty, prevTotal, payload.received_qty);
    if (gate.over) {
      const isFinance = access.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!payload.allow_over) {
        await notifyFinanceOverReceipt(supabase, line, gate);
        return {
          error: `⚠ 累计收货 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务。处理方向:①财务审批放行 ②退回布行 ③让布行补足到量 ④超出部分搁置等待。`,
          needsApproval: true, cap: gate.cap,
        };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行,你的角色不可勾「超收放行」;请联系财务审批' };
    }
  }
  const receivedAt = payload.received_date ? new Date(payload.received_date + 'T00:00:00+08:00').toISOString() : now;

  // 1. 追加一批
  const { error: grErr } = await (supabase.from('goods_receipts') as any).insert({
    line_item_id: lineItemId, order_id: line.order_id,
    received_qty: payload.received_qty, received_unit: line.ordered_unit || null,
    received_at: receivedAt, received_by: access.userId,
    inspection_result: 'pass',
    defect_notes: payload.note || null,
    photos: (payload.slip_paths && payload.slip_paths.length) ? payload.slip_paths : null,
  });
  if (grErr) return { error: grErr.message };

  // 2. 汇总实收 → 回写
  const { data: receipts } = await (supabase.from('goods_receipts') as any).select('received_qty').eq('line_item_id', lineItemId);
  const total = ((receipts || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
  const ordered = Number(line.ordered_qty) || 0;
  const complete = payload.mark_complete === true || (ordered > 0 && total >= ordered);
  const nextStatus = complete ? 'accepted' : 'arrived';   // 收齐→离队;未齐→留待验收继续录
  await (supabase.from('procurement_line_items') as any).update({
    received_qty: total, received_at: now, received_by: access.userId, line_status: nextStatus, updated_at: now,
  }).eq('id', lineItemId);

  // 3. 自动入库(增量 delta)
  try { const { recordInventoryReceipt } = await import('@/app/actions/inventory'); await recordInventoryReceipt(lineItemId); }
  catch (e: any) { console.warn('[recordReceiptBatch] 自动入库失败(不阻断):', e?.message); }
  // 4. 联动采购项收货状态
  try { const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items'); await syncProcurementItemReceivingStatus(line.order_id); }
  catch (e: any) { console.warn('[recordReceiptBatch] 采购项联动失败(不阻断):', e?.message); }

  await logProcurement(supabase, lineItemId, line.order_id, 'receive', line.line_status, nextStatus,
    `收货登记:本批 ${payload.received_qty}${line.ordered_unit || ''},累计 ${total}/${ordered}${complete ? '(已收齐)' : ''}${payload.allow_over ? ' [财务超收放行]' : ''}`,
    { batch: payload.received_qty, total, allow_over: !!payload.allow_over });
  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { ok: true, total_received: total, ordered, complete };
}

/** 某采购行的全部收货批次(含码单 signed URL)。 */
export async function listReceiptBatches(lineItemId: string): Promise<{ data?: any[]; error?: string }> {
  const access = await checkAccess();   // 只读:可见采购的角色都能看(业务/生产/仓库也要看到货进度)
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();
  const { data, error } = await (supabase.from('goods_receipts') as any)
    .select('id, received_qty, received_unit, received_at, defect_notes, photos, inspection_result')
    .eq('line_item_id', lineItemId).order('received_at', { ascending: true });
  if (error) return { error: error.message };
  const rows: any[] = [];
  for (const r of (data || []) as any[]) {
    const slipUrls: string[] = [];
    for (const p of (r.photos || [])) {
      const { data: signed } = await supabase.storage.from('order-docs').createSignedUrl(p, 3600);
      if (signed?.signedUrl) slipUrls.push(signed.signedUrl);
    }
    rows.push({ ...r, slip_urls: slipUrls });
  }
  return { data: rows };
}

// ── 采购中心工作队列（跨订单，供 /procurement 页只读渲染）──
export interface QueueLine {
  id: string;
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;   // 内部单号(财务核算口径,随行显示)
  customer_name: string | null;
  material_name: string;
  category: string | null;
  supplier_name: string | null;
  line_status: string;
  required_by: string | null;
  promised_date: string | null;
  expected_arrival: string | null;
  po_no: string | null;
  unit_price: number | null;
  price_variance_pct: number | null;
  ordered_qty: number | null;
  ordered_unit: string | null;
  received_qty: number | null;   // 已收(累计);未到货 = ordered_qty − received_qty
  chase_count: number | null;
  last_chased_at: string | null;
  lamp: 'red' | 'yellow' | 'green' | null;
}

/** 待采购订单(业务执行已提交采购申请,采购尚未完成下单)—— 订单级卡片 */
export interface PendingProcurementOrder {
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;  // 内部单号(订单册编号,财务核算口径)
  customer_name: string | null;
  submitted_at: string | null;   // 业务提交采购申请的时间(MRP 生成时间)
  req_count: number;             // 需求条数
  late_count: number;            // 已过最晚下单日的需求数(紧急)
}

export async function getProcurementQueues(): Promise<{
  data?: {
    /** 待采购订单:业务执行提交了采购申请 → 采购必须看见;完成「采购下单」节点后自动消失 */
    pendingRequests: PendingProcurementOrder[];
    pendingOrder: QueueLine[];
    chase: QueueLine[];
    readyShip: QueueLine[];
    receive: QueueLine[];
    counts: { pendingRequests: number; pendingOrder: number; chase: number; readyShip: number; receive: number; red: number };
  };
  error?: string;
}> {
  const auth = await checkAccess(); // 查看权限沿用较宽的 ALLOWED_ROLES(含 sales)
  if (!auth.ok) return { error: auth.error };
  const canSeeFloor = hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR');
  const supabase = await createClient();

  const { computeLineLamp } = await import('@/lib/domain/procurement');

  // ── 待采购订单(2026-07-03:业务执行「提交采购」后,采购中心必须出现这张订单)──
  // 信号 = material_plans 活跃(业务提交采购申请生成);消失 = 该单「采购下单」节点完成。
  const pendingRequests: PendingProcurementOrder[] = [];
  try {
    const { data: plans } = await (supabase.from('material_plans') as any)
      .select('order_id, mrp_generated_at, orders(order_no, internal_order_no, customer_name, lifecycle_status)')
      .eq('plan_status', 'active');
    const alive = (plans || []).filter((p: any) => {
      const ls = p.orders?.lifecycle_status || '';
      return !['completed', '已完成', 'cancelled', '已取消'].includes(ls);
    });
    const orderIds = alive.map((p: any) => p.order_id);
    if (orderIds.length > 0) {
      // 已完成「采购下单」节点的订单 → 出队
      const { data: doneMs } = await (supabase.from('milestones') as any)
        .select('order_id, status').in('order_id', orderIds).eq('step_key', 'procurement_order_placed');
      const doneOrders = new Set((doneMs || [])
        .filter((m: any) => ['done', '已完成'].includes(String(m.status || '').toLowerCase()))
        .map((m: any) => m.order_id));
      // 需求条数 + 紧急数(过最晚下单日)
      const { data: reqs } = await (supabase.from('material_requirements') as any)
        .select('order_id, timing_status').in('order_id', orderIds);
      const reqCount = new Map<string, number>();
      const lateCount = new Map<string, number>();
      for (const r of (reqs || [])) {
        reqCount.set(r.order_id, (reqCount.get(r.order_id) || 0) + 1);
        if (r.timing_status === 'late') lateCount.set(r.order_id, (lateCount.get(r.order_id) || 0) + 1);
      }
      // 自愈(2026-07-03):已全部下单但节点没完成的订单(如钩子上线前下的单)
      // → 顺手自动完成「采购下单」节点并本次出队,不再挂着"待采购"
      const { data: allItems } = await (supabase.from('procurement_items') as any)
        .select('order_id, status').in('order_id', orderIds);
      const ORDERED = ['ordered', 'partially_received', 'completed', 'closed'];
      const itemsByOrder = new Map<string, string[]>();
      for (const it of (allItems || [])) {
        const arr = itemsByOrder.get(it.order_id) || [];
        arr.push(it.status); itemsByOrder.set(it.order_id, arr);
      }
      for (const p of alive) {
        if (doneOrders.has(p.order_id)) continue;
        const sts = itemsByOrder.get(p.order_id) || [];
        // 采购项全部已下单/已收/完成 → 无条件出"待采购"队列。
        // 显示口径以「真实采购状态」为准,不再被里程碑标记的成败绑架
        // (原 bug:里程碑不存在/已 done 时 autoComplete 返回 false → 掉下去 push 回队列 → 收货了还挂待采购)。
        // 同时 fire-and-forget 把「采购下单」里程碑自动回填到节拍器(用户要求:不用手工回去点)。
        if (sts.length > 0 && sts.every(s => ORDERED.includes(s))) {
          try {
            const { autoCompleteProcurementPlacedForOrder } = await import('@/app/actions/procurement-items');
            void autoCompleteProcurementPlacedForOrder(supabase, p.order_id).catch(() => {});
          } catch { /* 自愈失败不影响队列出队 */ }
          continue;   // ← 无条件出队(修 ②③:收货后不再显示待采购/去核料)
        }
        pendingRequests.push({
          order_id: p.order_id,
          order_no: p.orders?.order_no ?? null,
          internal_order_no: p.orders?.internal_order_no ?? null,
          customer_name: p.orders?.customer_name ?? null,
          submitted_at: p.mrp_generated_at ?? null,
          req_count: reqCount.get(p.order_id) || 0,
          late_count: lateCount.get(p.order_id) || 0,
        });
      }
      pendingRequests.sort((a, b) => (b.late_count - a.late_count) || String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
    }
  } catch (e: any) {
    console.warn('[getProcurementQueues] 待采购订单查询失败(不阻断其余队列):', e?.message);
  }

  // 基础读走用户会话(RLS 管范围),不含已封锁的 unit_price(price_variance_pct 是百分比、非绝对价,保留);
  // 底价对 floor 角色在下方经 service-role 补(此前此处直接返回 unit_price 未剥离,是泄价点)。
  const { data, error } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, category, supplier_name, line_status, required_by, promised_date, expected_arrival, po_no, price_variance_pct, ordered_qty, ordered_unit, received_qty, chase_count, last_chased_at, orders(order_no, internal_order_no, customer_name, lifecycle_status)')
    .in('line_status', ['pending_order', 'ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived']);
  if (error) return { error: error.message };

  const now = new Date();
  const rows: QueueLine[] = (data || [])
    .filter((r: any) => {
      const ls = r.orders?.lifecycle_status || '';
      return !['completed', '已完成', 'cancelled', '已取消'].includes(ls);
    })
    .map((r: any) => ({
      id: r.id, order_id: r.order_id,
      order_no: r.orders?.order_no ?? null, internal_order_no: r.orders?.internal_order_no ?? null,
      customer_name: r.orders?.customer_name ?? null,
      material_name: r.material_name, category: r.category, supplier_name: r.supplier_name,
      line_status: r.line_status, required_by: r.required_by,
      promised_date: r.promised_date, expected_arrival: r.expected_arrival,
      po_no: r.po_no, unit_price: r.unit_price, price_variance_pct: r.price_variance_pct,
      ordered_qty: r.ordered_qty, ordered_unit: r.ordered_unit,
      received_qty: r.received_qty ?? null,
      chase_count: r.chase_count, last_chased_at: r.last_chased_at,
      lamp: computeLineLamp(r, { now }),
    }));

  // floor 角色 → 经 service-role 补回底价(基础读已剥离);非 floor 的 unit_price 保持 undefined
  if (canSeeFloor && rows.length) {
    const costs = await fetchLineCostsByIds(rows.map((r) => r.id));
    for (const r of rows) { const c = costs.get(r.id); if (c) r.unit_price = c.unit_price; }
  }

  const lampRank = (l: string | null) => (l === 'red' ? 0 : l === 'yellow' ? 1 : l === 'green' ? 2 : 3);
  const byLamp = (a: QueueLine, b: QueueLine) => lampRank(a.lamp) - lampRank(b.lamp);

  // 2026-07-03 用户拍板四段:待下单 / 待催货(生产中) / 已完成待送货+在途 / 已送达待验收
  const pendingOrder = rows.filter(r => r.line_status === 'pending_order').sort(byLamp);
  const chase = rows.filter(r => ['ordered', 'confirmed', 'in_production'].includes(r.line_status)).sort(byLamp);
  const readyShip = rows.filter(r => ['ready_to_ship', 'shipped'].includes(r.line_status)).sort(byLamp);
  const receive = rows.filter(r => r.line_status === 'arrived');

  return {
    data: {
      pendingRequests, pendingOrder, chase, readyShip, receive,
      counts: {
        pendingRequests: pendingRequests.length,
        pendingOrder: pendingOrder.length, chase: chase.length,
        readyShip: readyShip.length, receive: receive.length,
        red: rows.filter(r => r.lamp === 'red').length,
      },
    },
  };
}

// ── 采购风险中心（只读，读物化好的 procurement_matters）──
export type ProcurementMatterType =
  | 'material_shortage' | 'supplier_delay' | 'chase_stalled'
  | 'price_anomaly' | 'quality_reject' | 'risk_schedule';

export interface RiskMatter {
  id: string;
  order_id: string | null;
  order_no: string | null;
  line_item_id: string | null;
  matter_type: ProcurementMatterType;
  severity: 'high' | 'medium';
  title: string;
  evidence: Record<string, any>;
  detected_at: string;
}

/**
 * 采购风险中心数据（只读）。读 nightly cron 物化的 procurement_matters，
 * 按严重度→检出时间排序。CEO/PM 看汇总、点订单下钻；零页面计算。
 */
export async function getProcurementMatters(): Promise<{
  data?: { matters: RiskMatter[]; counts: { total: number; high: number; medium: number } };
  error?: string;
}> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();

  const { data, error } = await (supabase.from('procurement_matters') as any)
    .select('id, order_id, order_no, line_item_id, matter_type, severity, title, evidence, detected_at')
    .order('severity', { ascending: true }) // 'high' < 'medium' 字典序：high 在前
    .order('detected_at', { ascending: true });
  if (error) return { error: error.message };

  const matters: RiskMatter[] = (data || []) as RiskMatter[];
  return {
    data: {
      matters,
      counts: {
        total: matters.length,
        high: matters.filter(m => m.severity === 'high').length,
        medium: matters.filter(m => m.severity === 'medium').length,
      },
    },
  };
}
