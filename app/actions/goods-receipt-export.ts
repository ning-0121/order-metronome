'use server';

/**
 * 收货对账单导出(2026-07-11)。
 * 采购分批收货(goods_receipts:数量/日期/收货地址/码单附件)→ 按【供应商】和/或【物料名】筛选,
 * 导出 Excel(每供应商一个 sheet,抬头=供应商名,按日期排:日期/物料名/规格/数量/收货地址/码单),
 * 发供应商对账。权限:可见采购的角色可导出(只读 + 生成)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface ReceiptRow {
  lineItemId: string;   // 采购执行行 id(导出时经 service-role 回查单价)
  supplierId: string | null;
  supplierName: string;
  material: string;
  spec: string;
  color: string;        // 颜色(核料主数据 procurement_items.color;同料不同色分行对账)
  orderNo: string;      // 订单号(内部订单号优先;对账/财务锚点)
  qty: number;
  unit: string;
  price: number | null; // 单价(采购单底价 unit_price;列级封锁,仅导出时 service-role 填)
  date: string;         // YYYY-MM-DD
  address: string;
  photos: string[];     // order-docs 路径
}

/** 装配收货行:goods_receipts → 采购行 → 采购单 → 供应商。排除拒收(退货不计)。 */
async function loadReceiptRows(supabase: any): Promise<ReceiptRow[]> {
  const SEL = 'id, line_item_id, order_id, received_qty, received_unit, received_at, received_address, photos, inspection_result';
  let { data: grs, error } = await supabase.from('goods_receipts')
    .select(SEL).neq('inspection_result', 'reject').order('received_at', { ascending: true });
  // P3-4 审计:received_address 列(20260711 迁移)未跑时,硬 select 会报错→整表返回空(误导「无记录」)。
  //   与写入路径同款降级:缺列则去掉该列重查(address 置空)。
  if (error && /received_address|column .* does not exist|schema cache/i.test(error.message || '')) {
    ({ data: grs } = await supabase.from('goods_receipts')
      .select(SEL.replace(', received_address', '')).neq('inspection_result', 'reject').order('received_at', { ascending: true }));
  }
  const receipts = (grs || []) as any[];
  if (!receipts.length) return [];

  const lineIds = [...new Set(receipts.map((r) => r.line_item_id).filter(Boolean))];
  const { data: lines } = await supabase.from('procurement_line_items')
    .select('id, material_name, specification, size, ordered_unit, supplier_name, purchase_order_id, procurement_item_id')
    .in('id', lineIds);
  const lineMap = new Map((lines || []).map((l: any) => [l.id, l]));

  // 颜色在核料主数据上(执行行无颜色列;采购按颜色分行,对账单必须带色)
  const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean))];
  const colorMap = new Map<string, string>();
  if (piIds.length) {
    const { data: pis } = await supabase.from('procurement_items').select('id, color').in('id', piIds);
    for (const p of (pis || [])) if (p.color) colorMap.set(p.id, p.color);
  }

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

  // 订单号(2026-07-11 老板:对账单要带订单号):收货行挂订单,内部订单号优先(对账/财务锚点)
  const orderIds = [...new Set(receipts.map((r) => r.order_id).filter(Boolean))];
  const orderNoMap = new Map<string, string>();
  if (orderIds.length) {
    const { data: ords } = await supabase.from('orders').select('id, order_no, internal_order_no').in('id', orderIds);
    for (const o of (ords || [])) orderNoMap.set(o.id, o.internal_order_no || o.order_no || '');
  }

  const rows: ReceiptRow[] = [];
  for (const r of receipts) {
    const l: any = lineMap.get(r.line_item_id);
    if (!l) continue;
    const po = l.purchase_order_id ? poMap.get(l.purchase_order_id) : null;
    const supplierId = po?.supplier_id || null;
    const supplierName = (supplierId && supMap.get(supplierId)) || l.supplier_name || '(未关联供应商)';
    rows.push({
      lineItemId: r.line_item_id,
      supplierId,
      supplierName,
      material: l.material_name || '',
      spec: l.specification || l.size || '',
      color: (l.procurement_item_id && colorMap.get(l.procurement_item_id)) || '',
      orderNo: (r.order_id && orderNoMap.get(r.order_id)) || '',
      qty: round3(Number(r.received_qty) || 0),
      unit: r.received_unit || l.ordered_unit || '',
      price: null,   // 筛选项装配不带价;导出时经 service-role 回填
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

  // 回填单价(2026-07-11 老板:对账单要带单价):unit_price 是列级封锁的底价,经 service-role 读
  // (本函数已过 CAN_EDIT_PROCUREMENT_EXEC 门禁——能编采购执行的角色本就可见底价)。
  try {
    const svc = createServiceRoleClient();
    const ids = [...new Set(rows.map((r) => r.lineItemId).filter(Boolean))];
    if (ids.length) {
      const { data: priceLines } = await (svc.from('procurement_line_items') as any)
        .select('id, unit_price').in('id', ids);
      const priceMap = new Map<string, number | null>(((priceLines || []) as any[])
        .map((l) => [l.id, l.unit_price != null ? Number(l.unit_price) : null]));
      for (const r of rows) r.price = priceMap.get(r.lineItemId) ?? null;
    }
  } catch { /* 取价失败 → 单价列留空,导出不阻断 */ }

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
    [14, 13, 26, 16, 12, 12, 10, 12, 14, 30, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    // 抬头
    ws.mergeCells('A1:K1');
    const h = ws.getCell('A1');
    h.value = `${supplier} 收货对账单`;
    h.font = { name: '宋体', size: 16, bold: true };
    h.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;
    ws.mergeCells('A2:K2');
    const sub = ws.getCell('A2');
    sub.value = `义乌市绮陌服饰有限公司 · 导出日期 ${new Date().toISOString().slice(0, 10)} · 共 ${list.length} 批`;
    sub.font = { name: '宋体', size: 10, color: { argb: 'FF888888' } };
    sub.alignment = { horizontal: 'center' };
    // 表头(2026-07-11 老板:加 单价/金额/颜色/订单号)
    const hdr = ['日期', '订单号', '物料名', '规格', '颜色', '数量', '单位', '单价', '金额', '收货地址', '码单'];
    hdr.forEach((t, i) => {
      const c = ws.getCell(4, i + 1);
      c.value = t;
      c.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    ws.getRow(4).height = 24;

    let tr = 5, totalQty = 0, totalAmount = 0;
    for (const r of list) {
      const slipUrls: string[] = [];
      for (const p of r.photos) { const u = await sign(p); if (u) slipUrls.push(u); }
      const amount = r.price != null ? round2(r.qty * r.price) : null;   // 金额 = 收货数量 × 单价
      const cells: any[] = [r.date, r.orderNo, r.material, r.spec, r.color, r.qty, r.unit, r.price ?? '', amount ?? '', r.address, slipUrls.length ? `码单(${slipUrls.length})` : ''];
      cells.forEach((v, i) => {
        const c = ws.getCell(tr, i + 1);
        c.value = v;
        c.font = { name: '宋体', size: 11 };
        c.alignment = { horizontal: i === 2 || i === 9 ? 'left' : 'center', vertical: 'middle', wrapText: true };
        c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      // 码单超链接(第一张)
      if (slipUrls.length) {
        const c = ws.getCell(tr, 11);
        c.value = { text: `码单(${slipUrls.length})`, hyperlink: slipUrls[0] } as any;
        c.font = { name: '宋体', size: 11, color: { argb: 'FF0563C1' }, underline: true };
      }
      totalQty += r.qty;
      if (amount != null) totalAmount += amount;
      ws.getRow(tr).height = 20;
      tr++;
    }
    // 合计(数量 + 金额)
    ws.mergeCells(tr, 1, tr, 5);
    const tl = ws.getCell(tr, 1); tl.value = '合计'; tl.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
    tl.alignment = { horizontal: 'center' }; tl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    const tq = ws.getCell(tr, 6); tq.value = round3(totalQty); tq.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
    tq.alignment = { horizontal: 'center' }; tq.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    const ta = ws.getCell(tr, 9); ta.value = round2(totalAmount); ta.font = { name: '宋体', size: 12, bold: true, color: { argb: 'FFFF0000' } };
    ta.alignment = { horizontal: 'center' }; ta.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
    for (const c of [7, 8, 10, 11]) ws.getCell(tr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  }

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const first = [...bySupplier.keys()][0] || '收货';
  const filename = bySupplier.size === 1 ? `${first}_收货对账单.xlsx` : `收货对账单_${bySupplier.size}家供应商.xlsx`;
  return { data: { filename, base64, rowCount: rows.length } };
}
