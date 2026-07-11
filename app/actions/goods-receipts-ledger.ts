'use server';

/**
 * 收货记录台账(2026-07-11 老板:对账台账页要能调出所有收货数据,按供应商/日期/物料名筛)。
 * 一行 = 一次收货(goods_receipts),带 供应商/物料/规格/数量/检验结果/采购单号/关联订单。
 * 只读,不带价格列(页面对采购全角色开放;金额对账走供应商账目导入/采购流水导出)。
 * 页面已有 requireProcurementPage 门禁;此处再校登录,数据走用户会话(RLS 管范围)。
 */

import { createClient } from '@/lib/supabase/server';

export interface GoodsReceiptRow {
  id: string;
  received_at: string | null;
  supplier_name: string | null;
  material_name: string | null;
  specification: string | null;
  size: string | null;
  color: string | null;
  received_qty: number;
  unit: string | null;
  inspection_result: string | null;
  return_status: string | null;
  defect_notes: string | null;
  po_no: string | null;
  purchase_order_id: string | null;
  order_label: string | null;   // 内部订单号 || 绮陌单号
}

export async function listGoodsReceiptRecords(): Promise<{ data?: GoodsReceiptRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: receipts, error } = await (supabase.from('goods_receipts') as any)
    .select('id, line_item_id, order_id, received_qty, received_unit, received_at, inspection_result, defect_notes, return_status')
    .order('received_at', { ascending: false })
    .limit(2000);
  if (error) return { error: error.message };
  const rs = (receipts || []) as any[];
  if (rs.length === 0) return { data: [] };

  // 关联:收货行 → 采购执行行(物料/供应商/PO) → 采购单头(单号+供应商兜底) / 订单(双号)
  const lineIds = [...new Set(rs.map((r) => r.line_item_id).filter(Boolean))];
  const lineMap = new Map<string, any>();
  if (lineIds.length) {
    const { data: lines } = await (supabase.from('procurement_line_items') as any)
      .select('id, material_name, specification, size, ordered_unit, supplier_name, purchase_order_id, procurement_item_id')
      .in('id', lineIds);
    for (const l of (lines || [])) lineMap.set(l.id, l);
  }
  // 颜色在核料主数据上(采购按颜色分行)
  const piIds = [...new Set([...lineMap.values()].map((l: any) => l.procurement_item_id).filter(Boolean))];
  const colorMap = new Map<string, string | null>();
  if (piIds.length) {
    const { data: pis } = await (supabase.from('procurement_items') as any)
      .select('id, color').in('id', piIds);
    for (const p of (pis || [])) colorMap.set(p.id, p.color ?? null);
  }
  const poIds = [...new Set([...lineMap.values()].map((l: any) => l.purchase_order_id).filter(Boolean))];
  const poMap = new Map<string, any>();
  if (poIds.length) {
    const { data: pos } = await (supabase.from('purchase_orders') as any)
      .select('id, po_no, suppliers(name)').in('id', poIds);
    for (const p of (pos || [])) poMap.set(p.id, p);
  }
  const orderIds = [...new Set(rs.map((r) => r.order_id).filter(Boolean))];
  const orderMap = new Map<string, any>();
  if (orderIds.length) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', orderIds);
    for (const o of (ords || [])) orderMap.set(o.id, o);
  }

  const rows: GoodsReceiptRow[] = rs.map((r) => {
    const line = lineMap.get(r.line_item_id) || {};
    const po = line.purchase_order_id ? (poMap.get(line.purchase_order_id) || {}) : {};
    const ord = orderMap.get(r.order_id) || {};
    return {
      id: r.id,
      received_at: r.received_at ?? null,
      supplier_name: line.supplier_name || po.suppliers?.name || null,
      material_name: line.material_name ?? null,
      specification: line.specification ?? null,
      size: line.size ?? null,
      color: line.procurement_item_id ? (colorMap.get(line.procurement_item_id) ?? null) : null,
      received_qty: Number(r.received_qty) || 0,
      unit: r.received_unit || line.ordered_unit || null,
      inspection_result: r.inspection_result ?? null,
      return_status: r.return_status ?? null,
      defect_notes: r.defect_notes ?? null,
      po_no: po.po_no ?? null,
      purchase_order_id: line.purchase_order_id ?? null,
      order_label: ord.internal_order_no || ord.order_no || null,
    };
  });
  return { data: rows };
}

/**
 * 导出收货记录 Excel(2026-07-11)。导出的是【前端当前筛选后的行】——选了供应商/日期/物料,
 * 导出即所见即所得;filterLabel 写进表头注明筛选口径。合计按单位分开求和(米/个/kg 不混加)。
 */
export async function exportGoodsReceiptRecords(
  rows: GoodsReceiptRow[], filterLabel?: string
): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const list = (rows || []).slice(0, 5000);
  if (list.length === 0) return { error: '当前筛选没有收货记录,无可导出' };

  const INSPECT_CN: Record<string, string> = { pending: '待检', pass: '合格', concession: '让步接收', reject: '拒收' };
  const RETURN_CN: Record<string, string> = { pending: '待退', returned: '已退', replaced: '已换', waived: '免退' };

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'QIMO OS · 义乌市绮陌服饰有限公司';
  const ws = wb.addWorksheet('收货记录');
  ws.columns = [
    { header: '收货日期', width: 12 }, { header: '供应商', width: 18 }, { header: '物料', width: 22 },
    { header: '规格', width: 18 }, { header: '颜色', width: 12 }, { header: '尺码', width: 8 },
    { header: '数量', width: 10 }, { header: '单位', width: 8 }, { header: '检验', width: 10 },
    { header: '退货', width: 8 }, { header: '质量备注', width: 20 }, { header: '采购单号', width: 18 }, { header: '关联订单', width: 12 },
  ];
  ws.insertRow(1, [`收货记录台账${filterLabel ? ` · ${filterLabel}` : ''} · 共 ${list.length} 条`]);
  ws.mergeCells('A1:M1');
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.getRow(1).height = 22;
  ws.getRow(2).font = { bold: true };
  ws.getRow(2).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F5' } };
    cell.alignment = { horizontal: 'center' };
  });

  const unitTotals = new Map<string, number>();
  for (const r of list) {
    ws.addRow([
      r.received_at ? String(r.received_at).slice(0, 10) : '', r.supplier_name || '', r.material_name || '',
      r.specification || '', r.color || '', r.size || '',
      r.received_qty, r.unit || '', INSPECT_CN[r.inspection_result || ''] || r.inspection_result || '',
      r.return_status ? (RETURN_CN[r.return_status] || r.return_status) : '', r.defect_notes || '',
      r.po_no || '', r.order_label || '',
    ]);
    const u = r.unit || '—';
    unitTotals.set(u, (unitTotals.get(u) || 0) + r.received_qty);
  }
  const totalRow = ws.addRow(['合计', '', '', '', '', '',
    [...unitTotals.entries()].map(([u, n]) => `${Math.round(n * 1000) / 1000}${u === '—' ? '' : u}`).join(' + '),
    '', '', '', '', '', '']);
  totalRow.font = { bold: true };

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const dateTag = new Date().toISOString().slice(0, 10);
  return { base64, fileName: `收货记录_${filterLabel ? filterLabel.replace(/[\\/:*?"<>|\s~]/g, '_') + '_' : ''}${dateTag}.xlsx` };
}
