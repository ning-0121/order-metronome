'use server';

/**
 * 导出「打样申请单」Excel(2026-07-27)——按公司纸质样式生成,可打印/发工厂。
 * 读 orders(核心字段 + sample_request jsonb)+ order_line_items(颜色×尺码)。只读。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export async function exportSampleRequest(orderId: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  if (!orderId) return { error: '缺少订单' };

  const svc = createServiceRoleClient();
  const { data: order, error: oErr } = await (svc.from('orders') as any)
    .select('order_no, internal_order_no, customer_name, product_description, style_no, quantity, sample_request, notes, created_at')
    .eq('id', orderId).maybeSingle();
  if (oErr) return { error: `读订单失败:${oErr.message}` };
  if (!order) return { error: '订单不存在' };

  const { data: lines } = await (svc.from('order_line_items') as any)
    .select('color_cn, sizes, qty_pcs').eq('order_id', orderId).order('line_no');
  const rows = (lines || []) as any[];
  const sr = (order.sample_request || {}) as any;

  // 收集出现过的尺码列(保持常见顺序)
  const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'F'];
  const sizeSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.sizes || {})) if (Number(r.sizes[k]) > 0) sizeSet.add(k);
  const sizeCols = [...sizeSet].sort((a, b) => (SIZE_ORDER.indexOf(a) + 100) - (SIZE_ORDER.indexOf(b) + 100));

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('打样申请单');
  ws.properties.defaultColWidth = 12;
  const totalCols = Math.max(6, 2 + sizeCols.length + 1);
  const lastColLetter = String.fromCharCode(64 + Math.min(totalCols, 26));

  const line = (a: string, b?: string) => {
    const r = ws.addRow([a, b ?? '']);
    return r;
  };
  const merge = (row: number, from = 1, to = totalCols) =>
    ws.mergeCells(`${String.fromCharCode(64 + from)}${row}:${String.fromCharCode(64 + to)}${row}`);

  ws.addRow(['义乌绮陌服饰有限公司']); merge(1); ws.getCell('A1').alignment = { horizontal: 'center' }; ws.getCell('A1').font = { size: 11, color: { argb: 'FF888888' } };
  ws.addRow(['打 样 申 请 单']); merge(2); ws.getCell('A2').alignment = { horizontal: 'center' }; ws.getCell('A2').font = { bold: true, size: 18 };
  ws.addRow([`系统单号:${order.internal_order_no || order.order_no || ''}    建单日期:${String(order.created_at || '').slice(0, 10)}`]); merge(3);
  ws.getCell('A3').alignment = { horizontal: 'center' }; ws.getCell('A3').font = { size: 10, color: { argb: 'FF666666' } };
  ws.addRow([]);

  const kv = (label: string, value: string) => {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { bold: true };
    merge(r.number, 2, totalCols);
    r.getCell(1).border = r.getCell(2).border = { bottom: { style: 'hair' } } as any;
    return r;
  };
  kv('客    户', order.customer_name || '');
  kv('样衣性质', sr.sample_nature || '');
  kv('款式描述', order.product_description || '');
  kv('款    号', order.style_no || '');
  kv('总 数 量', String(order.quantity ?? ''));
  ws.addRow([]);

  // 面辅料
  ws.addRow(['面辅料信息如下']); ws.getCell(`A${ws.lastRow!.number}`).font = { bold: true };
  const fabrics = Array.isArray(sr.fabrics) ? sr.fabrics : [];
  fabrics.forEach((f: any, i: number) => { const r = ws.addRow([`面  料${i + 1}`, `${f.name || ''}`, '克重', `${f.gsm || ''}`]); r.getCell(1).font = { bold: true }; });
  const trims = Array.isArray(sr.trims) ? sr.trims : [];
  trims.forEach((t: string, i: number) => { const r = ws.addRow([`辅  料${i + 1}`, t || '']); r.getCell(1).font = { bold: true }; merge(r.number, 2, totalCols); });
  ws.addRow([]);

  // 颜色×尺码 表
  if (sizeCols.length > 0 && rows.length > 0) {
    ws.addRow(['颜色 / 尺码分色数量']); ws.getCell(`A${ws.lastRow!.number}`).font = { bold: true }; merge(ws.lastRow!.number);
    const header = ws.addRow(['颜色', ...sizeCols, '小计']);
    header.font = { bold: true }; header.alignment = { horizontal: 'center' };
    header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F5' } }; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'hair' }, right: { style: 'hair' } }; });
    for (const r of rows) {
      const sub = sizeCols.reduce((s, sz) => s + (Number(r.sizes?.[sz]) || 0), 0);
      const dr = ws.addRow([r.color_cn || '', ...sizeCols.map((sz) => Number(r.sizes?.[sz]) || ''), sub || '']);
      dr.eachCell((c) => { c.alignment = { horizontal: 'center' }; c.border = { left: { style: 'hair' }, right: { style: 'hair' }, bottom: { style: 'hair' } }; });
      dr.getCell(1).alignment = { horizontal: 'left' };
    }
    ws.addRow([]);
  }

  kv('特殊要求', sr.special_requirements || '');
  kv('备    注', order.notes || '');
  if (sr.swatch_note) kv('贴样说明', sr.swatch_note);
  ws.addRow([]);
  const signRow = ws.addRow(['审核签名', '', '', '审核日期', '', '']);
  signRow.getCell(1).font = signRow.getCell(4).font = { bold: true };

  ws.getColumn(1).width = 12;
  for (let c = 2; c <= totalCols; c++) ws.getColumn(c).width = 10;

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  const tag = order.internal_order_no || order.order_no || 'sample';
  return { base64, fileName: `打样申请单_${tag}.xlsx` };
}
