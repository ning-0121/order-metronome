'use server';

/**
 * 业务「订单汇总」周报导出(2026-07-04)—— 每周六业务要交的订单汇总表,系统代做。
 * 列对齐业务现用模板的「订单」sheet:每行 = 款×色 + 订单元数据。
 * 系统能填的自动填(客户/业务员/订单号/款名/颜色/类别/下单日/交期/面料名/款式图URL),
 * 系统没有的(面料类型/加工方法/面料供应商/面料交期/生产时间)留空,业务导出后手填。
 * 纯读导出,不写库。
 */

import { createClient } from '@/lib/supabase/server';

const ACTIVE_EXCLUDE = ['cancelled', '已取消', 'archived', '已归档'];

export async function exportMyOrderSummary(): Promise<{ base64?: string; fileName?: string; count?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 我负责的订单(负责人或创建者),排除已取消/归档
  const { data: ordersRaw, error: oErr } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, product_category, product_description, style_no, order_date, factory_date, etd, quantity, owner_user_id, created_by, lifecycle_status')
    .or(`owner_user_id.eq.${user.id},created_by.eq.${user.id}`)
    .order('order_date', { ascending: false });
  if (oErr) return { error: oErr.message };
  const orders = (ordersRaw || []).filter((o: any) => !ACTIVE_EXCLUDE.includes(o.lifecycle_status || ''));
  if (orders.length === 0) return { error: '没有可汇总的订单(你名下暂无活跃订单)' };
  const orderIds = orders.map((o: any) => o.id);

  // 业务员名字
  const ownerIds = [...new Set(orders.map((o: any) => o.owner_user_id).filter(Boolean))];
  const nameMap = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name, email').in('user_id', ownerIds);
    for (const p of (profs || [])) nameMap.set(p.user_id, p.name || p.email || '');
  }

  // 逐款逐色明细
  const { data: liRaw } = await (supabase.from('order_line_items') as any)
    .select('order_id, style_no, product_name, color_cn, color_en, fabric_name, image_url, qty_pcs, line_no')
    .in('order_id', orderIds)
    .order('order_id', { ascending: true }).order('line_no', { ascending: true });
  const linesByOrder = new Map<string, any[]>();
  for (const l of (liRaw || [])) {
    const arr = linesByOrder.get(l.order_id) || []; arr.push(l); linesByOrder.set(l.order_id, arr);
  }

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('订单汇总');
  const headers = ['NO', '款式图', '款名', '面料编号+成分', '面料类型', '加工方法', '面料供应商', '面料交期', '成衣类别', '客户', '业务员', '订单号', '生产时间', '下单日', '交期', '颜色'];
  const widths = [5, 10, 14, 18, 12, 10, 12, 10, 10, 12, 8, 12, 10, 10, 12, 8];
  ws.columns = widths.map((w) => ({ width: w }));

  const year = (orders[0]?.order_date || orders[0]?.factory_date || '').slice(0, 4) || '';
  ws.mergeCells(1, 1, 1, headers.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `${year ? year + '年' : ''}订单汇总`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center' };

  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });

  const ymd = (v: any) => (v ? String(v).slice(0, 10) : '');
  let no = 0;
  for (const o of orders) {
    const lines = linesByOrder.get(o.id) || [];
    const owner = nameMap.get(o.owner_user_id) || '';
    const orderNo = o.order_no || o.internal_order_no || '';
    const category = o.product_category || '';
    const orderDate = ymd(o.order_date);
    const delivery = ymd(o.factory_date) || ymd(o.etd);
    if (lines.length === 0) {
      // 无逐款明细的订单也出一行(款名用订单级款号/描述),数量走整单
      no++;
      ws.addRow([no, '', o.style_no || o.product_description || '', '', '', '', '', '', category, o.customer_name || '', owner, orderNo, '', orderDate, delivery, '']);
      continue;
    }
    for (const l of lines) {
      no++;
      const color = l.color_cn || l.color_en || '';
      ws.addRow([
        no, l.image_url || '', l.product_name || l.style_no || '', l.fabric_name || '',
        '', '', '', '',                    // 面料类型/加工方法/面料供应商/面料交期 → 手填
        category, o.customer_name || '', owner, orderNo,
        '', orderDate, delivery, color,    // 生产时间 → 手填
      ]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buf).toString('base64');
  const stamp = ymd(orders[0]?.order_date) || '';
  return { base64, fileName: `订单汇总_${owner_safe(nameMap, ownerIds)}${stamp ? '_' + stamp : ''}.xlsx`, count: no };
}

function owner_safe(nameMap: Map<string, string>, ownerIds: string[]): string {
  const n = ownerIds.length === 1 ? nameMap.get(ownerIds[0]) : '';
  return (n || '我的').replace(/[\\/:*?"<>|]/g, '');
}
