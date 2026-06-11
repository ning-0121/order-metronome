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

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  isValidLineTransition,
  LINE_STATUS_LABELS,
  CHASE_ESCALATION_THRESHOLD,
  ACTIVE_LINE_STATUSES,
  type ProcurementLineStatus,
} from '@/lib/domain/procurement';
import { isAdminRole } from '@/lib/domain/roles';

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

async function checkAccess(): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ALLOWED_ROLES.includes(r))) return { ok: false, error: '无权限' };
  return { ok: true, userId: user.id };
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
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data, error } = await (supabase.from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { error: error.message };

  const items = (data || []) as ProcurementLineItem[];

  // 汇总
  const totalOrdered = items.reduce((s, i) => s + (i.ordered_amount || 0), 0);
  const totalReceived = items
    .filter(i => i.received_qty !== null)
    .reduce((s, i) => s + ((i.received_qty || 0) * (i.unit_price || 0)), 0);
  const totalDifference = items.reduce((s, i) => s + (i.difference_amount || 0), 0);
  const discrepancyCount = items.filter(
    i => i.received_qty !== null && Math.abs(i.difference_pct || 0) > 3,
  ).length;

  return {
    data: items,
    summary: {
      totalOrdered: Number(totalOrdered.toFixed(2)),
      totalReceived: Number(totalReceived.toFixed(2)),
      totalDifference: Number(totalDifference.toFixed(2)),
      itemCount: items.length,
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

  const { data, error } = await (supabase.from('procurement_line_items') as any)
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
): Promise<{ error?: string }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();

  // 获取原始订购数据
  const { data: item } = await (supabase.from('procurement_line_items') as any)
    .select('ordered_qty, ordered_unit')
    .eq('id', itemId)
    .single();
  if (!item) return { error: '明细不存在' };

  // 判断状态
  let status = 'complete';
  const diff = receivedQty - (item as any).ordered_qty;
  if (receivedQty === 0) status = 'cancelled';
  else if (diff < -((item as any).ordered_qty * 0.03)) status = 'partial'; // 短缺 > 3%
  else if (diff > (item as any).ordered_qty * 0.03) status = 'over';      // 超发 > 3%

  const { error } = await (supabase.from('procurement_line_items') as any)
    .update({
      received_qty: receivedQty,
      received_unit: (item as any).ordered_unit,
      received_at: new Date().toISOString(),
      received_by: auth.userId,
      status,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { error: error.message };

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

  const supabase = await createClient();

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, factory_name, internal_order_no')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 获取采购明细
  const { data: items } = await (supabase.from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category')
    .order('created_at');

  if (!items || items.length === 0) return { error: '暂无采购明细' };

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = '订单节拍器';
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

  const { data: line, error: getErr } = await (supabase.from('procurement_line_items') as any)
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

  const { data: updated, error: upErr } = await (supabase.from('procurement_line_items') as any)
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
