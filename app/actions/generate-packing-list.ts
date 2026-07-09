'use server';

import { createClient } from '@/lib/supabase/server';
import { loadShippingDocModel } from '@/lib/services/shipping-docs';

/**
 * Packing List 生成器(ExcelJS,绮陌出口装箱单版式)。逐行=款×色;箱数/毛重/体积按实发现算;末行合计。
 * 数据统一走 loadShippingDocModel(与 CI/预览同源,永不偏差)。返回 { ok, base64, fileName }。
 */
export async function generatePackingList(
  orderId: string,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, false);  // PL 不含价
  if (error || !m) return { error: error || '数据不足' };
  const { order, seller, plNumber, plRows, plTotals } = m;

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('PACKING LIST');
  const thin = { style: 'thin' as const };
  const B4: any = { top: thin, left: thin, bottom: thin, right: thin };
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.3, header: 0, footer: 0 } };
  const COLW = [16, 20, 12, 16, 9, 10, 11, 9, 9, 9, 12, 12, 11, 16];
  COLW.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const setCell = (r: number, c: number, value: any, o: {
    size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; border?: boolean;
  } = {}) => {
    const x = ws.getCell(r, c);
    x.value = value === undefined || value === null ? '' : value;
    x.font = { name: 'Arial', size: o.size ?? 10, bold: o.bold ?? false };
    x.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.border !== false) x.border = { ...B4 };
  };
  const merge = (r1: number, c1: number, r2: number, c2: number) => ws.mergeCells(r1, c1, r2, c2);

  merge(1, 1, 1, 14); setCell(1, 1, seller.name_en, { size: 16, bold: true, border: false });
  merge(2, 1, 2, 14); setCell(2, 1, seller.address_en, { size: 9, border: false });
  merge(3, 1, 3, 14); setCell(3, 1, 'PACKING LIST', { size: 14, bold: true, border: false });
  merge(4, 1, 4, 7); setCell(4, 1, `Customer: ${order.customer_name || ''}    PO#: ${order.po_number || ''}`, { size: 10, align: 'left', border: false });
  merge(4, 8, 4, 14); setCell(4, 8, `Invoice No.: ${plNumber}    Internal: ${order.internal_order_no || order.order_no || ''}`, { size: 10, align: 'right', border: false });

  const HR = 6;
  const HEADERS = ['Style Number', 'Composition', 'Size', 'Color', 'Case Count', 'Units per Case',
    'Total Sets/Pcs', 'Length (cm)', 'Width (cm)', 'Height (cm)', 'PO #', 'Gross Weight (KG)', 'Volume (M³)', 'Additional Info'];
  HEADERS.forEach((h, i) => setCell(HR, i + 1, h, { bold: true, fill: 'FFF2F2F2', size: 9 }));

  let r = HR + 1;
  for (const l of plRows) {
    const vals = [l.style_no, l.composition, l.sizeText, l.color, l.cartons || '', l.per || '', l.qty || '',
      l.dl || '', l.dw || '', l.dh || '', order.po_number || '', l.grossTotal || '', l.vol || '', ''];
    vals.forEach((v, i) => setCell(r, i + 1, v, { size: 9, align: i === 1 || i === 3 ? 'left' : 'center' }));
    r++;
  }
  setCell(r, 1, 'TOTAL', { bold: true, align: 'left' });
  for (let c = 2; c <= 14; c++) setCell(r, c, '', {});
  setCell(r, 5, plTotals.cartons || '', { bold: true });
  setCell(r, 7, plTotals.qty || '', { bold: true });
  setCell(r, 12, Math.round(plTotals.gross * 10) / 10 || '', { bold: true });
  setCell(r, 13, Math.round(plTotals.vol * 1000) / 1000 || '', { bold: true });

  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `Packing List - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
