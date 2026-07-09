'use server';

import { createClient } from '@/lib/supabase/server';
import { EXPORT_SELLER } from '@/lib/domain/document-templates';

/**
 * Packing List 生成器(ExcelJS,1:1 复刻绮陌出口装箱单版式)。
 * 抬头=义乌绮陌(EXPORT_SELLER);逐行=款×色;箱数/毛重/体积按实发装箱现算;末行合计。
 * 数据源:packing_list_lines(出货事实)+ order_line_items(成分/尺码回查)+ orders(PO#/客户)。
 * 返回 { ok, base64, fileName } —— 前端 base64→Blob 下载(同 generate-production-order.ts)。
 */
export async function generatePackingList(
  orderId: string,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, po_number, customer_name, style_no')
    .eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };

  // 最新 draft/confirmed 装箱单
  const { data: pl } = await (supabase.from('packing_lists') as any)
    .select('id, pl_number').eq('order_id', orderId)
    .in('status', ['draft', 'confirmed', 'locked']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pl) return { error: '尚未录入出货装箱数据' };

  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('*').eq('packing_list_id', pl.id).order('sequence_no', { ascending: true });
  if (!lines || lines.length === 0) return { error: '装箱单没有明细行,请先录入实发装箱数据' };

  // 成分回查:款号 → fabric_name(PL 的 COMPOSITION 列)
  const { data: oli } = await (supabase.from('order_line_items') as any)
    .select('style_no, fabric_name').eq('order_id', orderId);
  const compByStyle = new Map<string, string>();
  for (const r of (oli || [])) if (r.style_no && r.fabric_name && !compByStyle.has(r.style_no)) compByStyle.set(r.style_no, r.fabric_name);

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('PACKING LIST');
  const thin = { style: 'thin' as const };
  const B4: any = { top: thin, left: thin, bottom: thin, right: thin };
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.3, header: 0, footer: 0 } };

  // 列宽(A–N,14 列)
  const COLW = [16, 20, 12, 16, 9, 10, 11, 9, 9, 9, 12, 12, 11, 16];
  COLW.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const setCell = (r: number, c: number, value: any, o: {
    size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; border?: boolean;
  } = {}) => {
    const cell = ws.getCell(r, c);
    cell.value = value === undefined || value === null ? '' : value;
    cell.font = { name: 'Arial', size: o.size ?? 10, bold: o.bold ?? false };
    cell.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.border !== false) cell.border = { ...B4 };
    return cell;
  };
  const merge = (r1: number, c1: number, r2: number, c2: number) => ws.mergeCells(r1, c1, r2, c2);

  // ── 抬头 ──
  merge(1, 1, 1, 14); setCell(1, 1, EXPORT_SELLER.name_en, { size: 16, bold: true, border: false });
  merge(2, 1, 2, 14); setCell(2, 1, EXPORT_SELLER.address_en, { size: 9, border: false });
  merge(3, 1, 3, 14); setCell(3, 1, 'PACKING LIST', { size: 14, bold: true, border: false });
  merge(4, 1, 4, 7); setCell(4, 1, `Customer: ${order.customer_name || ''}    PO#: ${order.po_number || ''}`, { size: 10, align: 'left', border: false });
  merge(4, 8, 4, 14); setCell(4, 8, `Invoice No.: ${pl.pl_number}    Internal: ${order.internal_order_no || order.order_no || ''}`, { size: 10, align: 'right', border: false });

  // ── 表头(第6行)──
  const HR = 6;
  const HEADERS = ['Style Number', 'Composition', 'Size', 'Color', 'Case Count', 'Units per Case',
    'Total Sets/Pcs', 'Length (cm)', 'Width (cm)', 'Height (cm)', 'PO #', 'Gross Weight (KG)', 'Volume (M³)', 'Additional Info'];
  HEADERS.forEach((h, i) => setCell(HR, i + 1, h, { bold: true, fill: 'FFF2F2F2', size: 9 }));

  // ── 数据行 ──
  const sizeText = (sb: any): string => {
    if (!sb || typeof sb !== 'object') return '';
    const keys = Object.keys(sb).filter(k => Number(sb[k]) > 0);
    if (keys.length === 0) return '';
    return keys.join('-') + '\n' + keys.map(k => sb[k]).join('-');
  };
  let r = HR + 1;
  let totCartons = 0, totQty = 0, totGross = 0, totVol = 0;
  for (const l of lines) {
    const cartons = Number(l.carton_count) || 0;
    const perCarton = Number(l.qty_per_carton) || 0;
    const qty = Number(l.total_qty) || 0;
    const d = l.carton_dims_cm || {};
    const dl = Number(d.l) || 0, dw = Number(d.w) || 0, dh = Number(d.h) || 0;
    const grossPer = Number(l.gross_weight_per_carton) || 0;
    const grossTotal = Math.round(cartons * grossPer * 10) / 10;
    const vol = dl && dw && dh ? Math.round((dl * dw * dh) * cartons / 1_000_000 * 1000) / 1000 : 0;
    totCartons += cartons; totQty += qty; totGross += grossTotal; totVol += vol;
    const vals = [
      l.style_no || '', compByStyle.get(l.style_no) || '', sizeText(l.size_breakdown), l.color || '',
      cartons || '', perCarton || '', qty || '', dl || '', dw || '', dh || '',
      order.po_number || '', grossTotal || '', vol || '', '',
    ];
    vals.forEach((v, i) => setCell(r, i + 1, v, { size: 9, align: i === 1 || i === 3 ? 'left' : 'center' }));
    r++;
  }

  // ── 合计行 ──
  setCell(r, 1, 'TOTAL', { bold: true, align: 'left' });
  for (let c = 2; c <= 14; c++) setCell(r, c, '', {});
  setCell(r, 5, totCartons || '', { bold: true });
  setCell(r, 7, totQty || '', { bold: true });
  setCell(r, 12, Math.round(totGross * 10) / 10 || '', { bold: true });
  setCell(r, 13, Math.round(totVol * 1000) / 1000 || '', { bold: true });

  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `Packing List - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
