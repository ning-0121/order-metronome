'use server';

/**
 * 导出「生产跟单表」Excel — 简版
 *
 * 目标：让生产部从订单下达第一天起就心里有数、可以提前计划。
 * 只显示他们真正需要的 6 列：
 *   订单号 · 内部单号 · 客户 · 数量(件) · 交期 · 业务
 *
 * 权限：
 *   - admin / finance / production_manager / admin_assistant / procurement → 全公司所有进行中订单
 *   - merchandiser / sales → 只能下载自己相关的订单
 */

import { createClient } from '@/lib/supabase/server';

interface ExportRow {
  order_no: string;
  internal_order_no: string;
  customer: string;
  style_no: string;
  style_count: number | null;
  color_count: number | null;
  quantity: number;
  delivery_date: string;
  sales: string;
  urgent: boolean;
}

export async function exportProductionTrackingSheet(): Promise<{
  error?: string;
  base64?: string;
  fileName?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  const canSeeAll = userRoles.some((r: string) =>
    ['admin', 'finance', 'production_manager', 'admin_assistant', 'procurement'].includes(r)
  );
  const canSeeOwn = userRoles.some((r: string) => ['merchandiser', 'sales'].includes(r));

  if (!canSeeAll && !canSeeOwn) {
    return { error: '无权限导出 — 仅管理员/财务/采购/生产主管/行政督办/跟单/业务可下载' };
  }

  let ordersQuery = (supabase.from('orders') as any)
    .select(
      'id, order_no, internal_order_no, customer_name, style_no, style_count, color_count, colors, quantity, factory_date, etd, cancel_date, special_tags, status, owner_user_id, created_by',
    )
    .not('status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")')
    .order('factory_date', { ascending: true, nullsFirst: false });

  if (!canSeeAll) {
    const [{ data: createdRows }, { data: ownedRows }, { data: msRows }] = await Promise.all([
      (supabase.from('orders') as any).select('id').eq('created_by', user.id),
      (supabase.from('orders') as any).select('id').eq('owner_user_id', user.id),
      (supabase.from('milestones') as any).select('order_id').eq('owner_user_id', user.id),
    ]);
    const myOrderIds = new Set<string>([
      ...((createdRows || []) as any[]).map((r: any) => r.id),
      ...((ownedRows || []) as any[]).map((r: any) => r.id),
      ...((msRows || []) as any[]).map((r: any) => r.order_id),
    ]);
    if (myOrderIds.size === 0) {
      return { error: '你当前没有任何进行中的订单可以导出' };
    }
    ordersQuery = ordersQuery.in('id', Array.from(myOrderIds));
  }

  const { data: orders, error: orderErr } = await ordersQuery;
  if (orderErr) return { error: orderErr.message };
  if (!orders || orders.length === 0) return { error: '当前没有进行中的订单' };

  // 批量拿业务名字（created_by）
  const salesIds = [...new Set((orders as any[]).map((o: any) => o.created_by).filter(Boolean))];
  const nameMap = new Map<string, string>();
  if (salesIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', salesIds);
    for (const p of (profiles || []) as any[]) {
      nameMap.set(p.user_id, p.name || p.email?.split('@')[0] || '');
    }
  }

  // 组织行
  const rows: ExportRow[] = (orders as any[]).map((o: any) => {
    // 交期：优先 factory_date（出厂日），没有就用 etd
    const delivery = o.factory_date || o.etd || o.cancel_date || '';
    const tags: string[] = Array.isArray(o.special_tags) ? o.special_tags : [];
    const urgent = tags.includes('rush') || tags.includes('加急');

    // 兜底：如果没存 color_count，直接从 colors jsonb 数组长度推断
    const colorsArr = Array.isArray(o.colors) ? o.colors : [];
    const colorCount = o.color_count ?? (colorsArr.length > 0 ? colorsArr.length : null);

    return {
      order_no: o.order_no || '',
      internal_order_no: o.internal_order_no || '',
      customer: o.customer_name || '',
      style_no: o.style_no || '',
      style_count: o.style_count ?? null,
      color_count: colorCount,
      quantity: o.quantity || 0,
      delivery_date: delivery ? String(delivery).slice(0, 10) : '',
      sales: nameMap.get(o.created_by) || '',
      urgent,
    };
  });

  // 生成 Excel
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = '订单节拍器';
  wb.created = new Date();
  const ws = wb.addWorksheet('生产订单一览', { views: [{ state: 'frozen', ySplit: 2 }] });

  // 标题
  ws.mergeCells('A1:J1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `生产订单一览 — ${new Date().toLocaleDateString('zh-CN')}（共 ${rows.length} 单）`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  ws.getRow(1).height = 28;

  // 表头
  const headers = ['订单号', '内部单号', '客户', '款号', '款数', '色数', '数量(件)', '交期', '业务', '加急'];
  const headerRow = ws.getRow(2);
  headerRow.values = headers;
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
  });

  // 数据行
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 3);
    row.values = [
      r.order_no,
      r.internal_order_no,
      r.customer,
      r.style_no,
      r.style_count ?? '',
      r.color_count ?? '',
      r.quantity,
      r.delivery_date,
      r.sales,
      r.urgent ? '🔥 加急' : '',
    ];
    row.height = 20;
    row.alignment = { vertical: 'middle' };

    if (r.urgent) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      });
      row.getCell(10).font = { bold: true, color: { argb: 'FFDC2626' } };
    }

    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        bottom: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        left: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        right: { style: 'thin', color: { argb: 'FFF3F4F6' } },
      };
    });
  });

  // 列宽
  const widths = [16, 14, 20, 14, 7, 7, 10, 12, 10, 10];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const fileName = `生产订单一览_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return { base64, fileName };
}
