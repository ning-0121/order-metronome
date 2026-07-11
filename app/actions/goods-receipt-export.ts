'use server';

/**
 * 收货对账单导出(2026-07-11)。
 * 采购分批收货(goods_receipts:数量/日期/收货地址/码单附件)→ 按【供应商】和/或【物料名】筛选,
 * 导出 Excel(每供应商一个 sheet,抬头=供应商名,按日期排:日期/物料名/规格/数量/收货地址/码单),
 * 发供应商对账。权限:可见采购的角色可导出(只读 + 生成)。
 */

import { createClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface ReceiptRow {
  supplierId: string | null;
  supplierName: string;
  material: string;
  spec: string;
  qty: number;
  unit: string;
  date: string;         // YYYY-MM-DD
  address: string;
  photos: string[];     // order-docs 路径
}

/** 装配收货行:goods_receipts → 采购行 → 采购单 → 供应商。排除拒收(退货不计)。 */
async function loadReceiptRows(supabase: any): Promise<ReceiptRow[]> {
  const { data: grs } = await supabase.from('goods_receipts')
    .select('id, line_item_id, received_qty, received_unit, received_at, received_address, photos, inspection_result')
    .neq('inspection_result', 'reject')
    .order('received_at', { ascending: true });
  const receipts = (grs || []) as any[];
  if (!receipts.length) return [];

  const lineIds = [...new Set(receipts.map((r) => r.line_item_id).filter(Boolean))];
  const { data: lines } = await supabase.from('procurement_line_items')
    .select('id, material_name, specification, size, ordered_unit, supplier_name, purchase_order_id')
    .in('id', lineIds);
  const lineMap = new Map((lines || []).map((l: any) => [l.id, l]));

  const poIds = [...new Set((lines || []).map((l: any) => l.purchase_order_id).filter(Boolean))];
  const poMap = new Map<string, any>();
  if (poIds.length) {
    const { data: pos } = await supabase.from('purchase_orders').select('id, supplier_id').in('id', poIds);
    for (const p of (pos || [])) poMap.set(p.id, p);
  }
  const supIds = [...new Set([...poMap.values()].map((p) => p.supplier_id).filter(Boolean))];
  const supMap = new Map<string, string>();
  if (supIds.length) {
    const { data: sups } = await supabase.from('suppliers').select('id, name').in('id', supIds);
    for (const s of (sups || [])) supMap.set(s.id, s.name);
  }

  const rows: ReceiptRow[] = [];
  for (const r of receipts) {
    const l: any = lineMap.get(r.line_item_id);
    if (!l) continue;
    const po = l.purchase_order_id ? poMap.get(l.purchase_order_id) : null;
    const supplierId = po?.supplier_id || null;
    const supplierName = (supplierId && supMap.get(supplierId)) || l.supplier_name || '(未关联供应商)';
    rows.push({
      supplierId,
      supplierName,
      material: l.material_name || '',
      spec: l.specification || l.size || '',
      qty: round3(Number(r.received_qty) || 0),
      unit: r.received_unit || l.ordered_unit || '',
      date: (r.received_at || '').slice(0, 10),
      address: r.received_address || '',
      photos: Array.isArray(r.photos) ? r.photos : [],
    });
  }
  return rows;
}

/** 筛选项:出现过收货的供应商 + 物料名。 */
export async function getReceiptStatementFilters(): Promise<{ suppliers: { id: string; name: string }[]; materials: string[] }> {
  const supabase = await createClient();
  const rows = await loadReceiptRows(supabase);
  const supMap = new Map<string, string>();
  const mats = new Set<string>();
  for (const r of rows) {
    supMap.set(r.supplierId || `__${r.supplierName}`, r.supplierName);
    if (r.material) mats.add(r.material);
  }
  const suppliers = [...supMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { suppliers, materials: [...mats].sort((a, b) => a.localeCompare(b, 'zh')) };
}

/**
 * 导出收货对账单。supplierIds / materialNames 都可空(空=不筛该维度);两者可单选/双选。
 * 返回 base64 xlsx。
 */
export async function exportGoodsReceiptStatement(filters: {
  supplierIds?: string[]; materialNames?: string[];
}): Promise<{ data?: { filename: string; base64: string; rowCount: number }; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };
  const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', '无权导出收货对账单');
  if (gate) return { error: gate };

  let rows = await loadReceiptRows(supabase);
  const supSet = filters.supplierIds && filters.supplierIds.length ? new Set(filters.supplierIds) : null;
  const matSet = filters.materialNames && filters.materialNames.length ? new Set(filters.materialNames) : null;
  if (supSet) rows = rows.filter((r) => supSet.has(r.supplierId || `__${r.supplierName}`));
  if (matSet) rows = rows.filter((r) => matSet.has(r.material));
  if (!rows.length) return { error: '没有符合条件的收货记录' };

  // 码单签名 URL(7 天,发供应商够用)
  const signCache = new Map<string, string>();
  async function sign(path: string): Promise<string> {
    if (signCache.has(path)) return signCache.get(path)!;
    const { data } = await supabase.storage.from('order-docs').createSignedUrl(path, 604800);
    const url = data?.signedUrl || '';
    signCache.set(path, url);
    return url;
  }

  // 按供应商分组
  const bySupplier = new Map<string, ReceiptRow[]>();
  for (const r of rows) {
    const k = r.supplierName;
    if (!bySupplier.has(k)) bySupplier.set(k, []);
    bySupplier.get(k)!.push(r);
  }

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'QIMO OS · 义乌市绮陌服饰有限公司';
  const usedNames = new Set<string>();
  const safeName = (raw: string) => {
    let n = (raw || '收货').replace(/[\\/\?\*\[\]:]/g, ' ').slice(0, 28) || '收货';
    let i = 2; const base = n;
    while (usedNames.has(n)) n = `${base.slice(0, 25)}(${i++})`;
    usedNames.add(n); return n;
  };

  for (const [supplier, list] of bySupplier) {
    const ws = wb.addWorksheet(safeName(supplier));
    [14, 26, 16, 12, 10, 30, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    // 抬头
    ws.mergeCells('A1:G1');
    const h = ws.getCell('A1');
    h.value = `${supplier} 收货对账单`;
    h.font = { name: '宋体', size: 16, bold: true };
    h.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;
    ws.mergeCells('A2:G2');
    const sub = ws.getCell('A2');
    sub.value = `义乌市绮陌服饰有限公司 · 导出日期 ${new Date().toISOString().slice(0, 10)} · 共 ${list.length} 批`;
    sub.font = { name: '宋体', size: 10, color: { argb: 'FF888888' } };
    sub.alignment = { horizontal: 'center' };
    // 表头
    const hdr = ['日期', '物料名', '规格', '数量', '单位', '收货地址', '码单'];
    hdr.forEach((t, i) => {
      const c = ws.getCell(4, i + 1);
      c.value = t;
      c.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    ws.getRow(4).height = 24;

    let tr = 5, totalQty = 0;
    for (const r of list) {
      const slipUrls: string[] = [];
      for (const p of r.photos) { const u = await sign(p); if (u) slipUrls.push(u); }
      const cells: any[] = [r.date, r.material, r.spec, r.qty, r.unit, r.address, slipUrls.length ? `码单(${slipUrls.length})` : ''];
      cells.forEach((v, i) => {
        const c = ws.getCell(tr, i + 1);
        c.value = v;
        c.font = { name: '宋体', size: 11 };
        c.alignment = { horizontal: i === 1 || i === 5 ? 'left' : 'center', vertical: 'middle', wrapText: true };
        c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      // 码单超链接(第一张)
      if (slipUrls.length) {
        const c = ws.getCell(tr, 7);
        c.value = { text: `码单(${slipUrls.length})`, hyperlink: slipUrls[0] } as any;
        c.font = { name: '宋体', size: 11, color: { argb: 'FF0563C1' }, underline: true };
      }
      totalQty += r.qty;
      ws.getRow(tr).height = 20;
      tr++;
    }
    // 合计
    ws.mergeCells(tr, 1, tr, 3);
    const tl = ws.getCell(tr, 1); tl.value = '合计'; tl.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
    tl.alignment = { horizontal: 'center' }; tl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    const tq = ws.getCell(tr, 4); tq.value = round3(totalQty); tq.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
    tq.alignment = { horizontal: 'center' }; tq.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    for (let c = 5; c <= 7; c++) ws.getCell(tr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  }

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const first = [...bySupplier.keys()][0] || '收货';
  const filename = bySupplier.size === 1 ? `${first}_收货对账单.xlsx` : `收货对账单_${bySupplier.size}家供应商.xlsx`;
  return { data: { filename, base64, rowCount: rows.length } };
}
