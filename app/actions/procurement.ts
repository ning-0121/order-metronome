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
  },
): Promise<{ error?: string; data?: ProcurementLineItem }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();
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
      ordered_by: auth.userId,
      ordered_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { data: data as ProcurementLineItem };
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
