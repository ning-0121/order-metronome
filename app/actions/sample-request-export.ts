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

  const merge = (row: number, from = 1, to = totalCols) =>
    ws.mergeCells(`${String.fromCharCode(64 + from)}${row}:${String.fromCharCode(64 + to)}${row}`);

  ws.addRow(['义乌绮陌服饰有限公司']); merge(1); ws.getCell('A1').alignment = { horizontal: 'center' }; ws.getCell('A1').font = { size: 11, color: { argb: 'FF888888' } };
  ws.addRow(['打 样 申 请 单']); merge(2); ws.getCell('A2').alignment = { horizontal: 'center' }; ws.getCell('A2').font = { bold: true, size: 18 };
  ws.addRow([`系统单号:${order.internal_order_no || order.order_no || ''}    建单日期:${String(order.created_at || '').slice(0, 10)}`]); merge(3);
  ws.getCell('A3').alignment = { horizontal: 'center' }; ws.getCell('A3').font = { size: 10, color: { argb: 'FF666666' } };
  ws.addRow([]);

  // 与纸质模板对齐:2 列 键值块 + 固定「面料1/2(含克重)+辅料1/2/3」表格式 + 尺码行 + 贴样处 + 审核栏。
  const colL = (n: number) => String.fromCharCode(64 + n);
  const mid = Math.max(3, Math.ceil(totalCols / 2));
  const cellBottom = { bottom: { style: 'hair' } } as any;
  // 一行两组键值:标签1|值1(合并到 mid) 标签2|值2(合并到末列)
  const kv2 = (l1: string, v1: string, l2: string, v2: string) => {
    const r = ws.addRow([]); const n = r.number;
    ws.getCell(`A${n}`).value = l1; ws.getCell(`A${n}`).font = { bold: true };
    ws.mergeCells(`B${n}:${colL(mid)}${n}`); ws.getCell(`B${n}`).value = v1; ws.getCell(`B${n}`).border = cellBottom;
    ws.getCell(`${colL(mid + 1)}${n}`).value = l2; ws.getCell(`${colL(mid + 1)}${n}`).font = { bold: true };
    ws.mergeCells(`${colL(mid + 2)}${n}:${colL(totalCols)}${n}`); ws.getCell(`${colL(mid + 2)}${n}`).value = v2; ws.getCell(`${colL(mid + 2)}${n}`).border = cellBottom;
  };
  // 一行单键值(值合并到末列)
  const kv1 = (l: string, v: string) => {
    const r = ws.addRow([l, v]); r.getCell(1).font = { bold: true };
    ws.mergeCells(`B${r.number}:${colL(totalCols)}${r.number}`); r.getCell(2).border = cellBottom;
  };
  const sizeText = sizeCols.length > 0 ? sizeCols.join(' / ') : ((order as any).sizes || '');

  kv2('客    户', order.customer_name || '', '样衣性质', sr.sample_nature || '');
  kv2('款式描述', order.product_description || '', '款    号', order.style_no || '');
  kv2('尺    码', String(sizeText), '总 数 量', String(order.quantity ?? ''));
  ws.addRow([]);

  // 面辅料信息如下(固定 2 面料含克重 + 3 辅料,空着也留位,对齐模板表单)
  const hdr = ws.addRow(['面辅料信息如下']); ws.getCell(`A${hdr.number}`).font = { bold: true };
  const fabrics = Array.isArray(sr.fabrics) ? sr.fabrics : [];
  const trims = Array.isArray(sr.trims) ? sr.trims : [];
  for (let i = 0; i < 2; i++) {
    const f = fabrics[i] || {};
    const r = ws.addRow([]); const n = r.number;
    ws.getCell(`A${n}`).value = `面  料${i + 1}`; ws.getCell(`A${n}`).font = { bold: true };
    ws.mergeCells(`B${n}:${colL(mid)}${n}`); ws.getCell(`B${n}`).value = f.name || ''; ws.getCell(`B${n}`).border = cellBottom;
    ws.getCell(`${colL(mid + 1)}${n}`).value = '克重'; ws.getCell(`${colL(mid + 1)}${n}`).font = { bold: true };
    ws.mergeCells(`${colL(mid + 2)}${n}:${colL(totalCols)}${n}`); ws.getCell(`${colL(mid + 2)}${n}`).value = f.gsm || ''; ws.getCell(`${colL(mid + 2)}${n}`).border = cellBottom;
  }
  for (let i = 0; i < 3; i++) kv1(`辅  料${i + 1}`, trims[i] || '');
  ws.addRow([]);

  // 颜色×尺码 分色数量表(始终画表头结构;有数据填数据,无则留空行)
  ws.addRow(['颜色 / 尺码分色数量']); ws.getCell(`A${ws.lastRow!.number}`).font = { bold: true }; merge(ws.lastRow!.number);
  const tableSizes = sizeCols.length > 0 ? sizeCols : ['S', 'M', 'L'];
  const header = ws.addRow(['颜色', ...tableSizes, '小计']);
  header.font = { bold: true }; header.alignment = { horizontal: 'center' };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F5' } }; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'hair' }, right: { style: 'hair' } }; });
  const dataRows = rows.length > 0 ? rows : [{ color_cn: '', sizes: {} }];
  for (const r of dataRows) {
    const sub = tableSizes.reduce((s, sz) => s + (Number(r.sizes?.[sz]) || 0), 0);
    const dr = ws.addRow([r.color_cn || '', ...tableSizes.map((sz) => Number(r.sizes?.[sz]) || ''), sub || '']);
    dr.eachCell((c) => { c.alignment = { horizontal: 'center' }; c.border = { left: { style: 'hair' }, right: { style: 'hair' }, bottom: { style: 'hair' } }; });
    dr.getCell(1).alignment = { horizontal: 'left' };
  }
  ws.addRow([]);

  kv1('特殊要求', sr.special_requirements || '');
  kv1('备    注', order.notes || '');
  kv1('贴样处说明', sr.swatch_note || '');
  ws.addRow([]);
  const signRow = ws.addRow([]); const sn = signRow.number;
  ws.getCell(`A${sn}`).value = '审核签名'; ws.getCell(`A${sn}`).font = { bold: true };
  ws.getCell(`${colL(mid + 1)}${sn}`).value = '审核日期'; ws.getCell(`${colL(mid + 1)}${sn}`).font = { bold: true };

  ws.getColumn(1).width = 12;
  for (let c = 2; c <= totalCols; c++) ws.getColumn(c).width = 11;

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  const tag = order.internal_order_no || order.order_no || 'sample';
  return { base64, fileName: `打样申请单_${tag}.xlsx` };
}
