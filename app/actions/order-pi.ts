'use server';

/**
 * 订单 PI(形式发票 Proforma Invoice)· 生成 / 保存 / 导出(2026-07-09 用户)。
 * 版式严格对齐绮陌标准 PI 模板(PI for AAFB 119):14 列 + Jojo Fashion 抬头 + 买方/运输表头 + 合计行 + DEPOSIT。
 * 生成:从「生产单(逐款明细 order_line_items)」按款号归组,带款/色(逐色带量)/尺码/描述/箱数/数量,
 *      单价取客户 PO 成交价(po_unit_price)。业务补齐成分/克重/尺码配比/运输信息 → 存 order_pi(jsonb)。
 * 开票方抬头(Jojo Fashion Inc)是固定常量,不入库。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const CAN_EDIT_PI = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

// 开票方固定抬头(取自绮陌标准 PI 模板 · Jojo Fashion Inc)
const ISSUER = {
  company: 'Jojo Fashion Inc',
  address: '16 Technology Dr, Ste 152,Irvine, CA, 92618',
  contact: 'CONTACT: ALEX QIN    PHONE: +86-18267048811   EMAIL: ALEX@QIMOCLOTHING.COM',
  title: 'PROFORMA INVOICE',
};

// 一行 = 一个款(多颜色并入 COLOR 单元格逐色带量)。列序严格对齐模板 A–N。
export interface PILine {
  po_no: string;          // A  PO NO.
  style_no: string;       // B  STYLE NO.
  style: string;          // C  STYLE(款名,可空)
  size: string;           // D  SIZE(如 "S-M-L-XL / 1-2-2-1")
  color: string;          // E  COLOR(多行:BLACK(1200SETS)…)
  description: string;    // F  DESCRIPTION
  composition: string;    // G  COMPOSITION(如 85%POLYESTER 15%SPANDEX)
  fabric_weight: string;  // H  FABRIC WEIGHT(如 280GSM)
  total_carton: number;   // I  TOTAL CARTON
  unit_per_carton: number;// J  UNIT PER CARTON
  qty: number;            // K  QTY(SETS/PCS)
  unit_price: number;     // L  UNIT PRICE(USD) LDP
  notes: string;          // N  NOTES(M=AMOUNT 由 qty×price 自动算)
}
export interface PIData {
  buyer_name: string; buyer_address: string; buyer_tel: string;
  invoice_no: string; issue_date: string; ship_via: string; destination: string;
  hbl: string; container: string; etd: string; eta: string;
  deposit: string; currency: string;
  lines: PILine[];
}

type PIBundle = PIData & { issuer: typeof ISSUER; has_saved: boolean; order_no: string | null };

function emptyLine(): PILine {
  return { po_no: '', style_no: '', style: '', size: '', color: '', description: '', composition: '', fabric_weight: '', total_carton: 0, unit_per_carton: 0, qty: 0, unit_price: 0, notes: '' };
}

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles };
}

function cleanData(data: Partial<PIData>): PIData {
  const s = (v: any) => String(v ?? '');
  const num = (v: any) => Number(v) || 0;
  return {
    buyer_name: s(data.buyer_name), buyer_address: s(data.buyer_address), buyer_tel: s(data.buyer_tel),
    invoice_no: s(data.invoice_no), issue_date: s(data.issue_date), ship_via: s(data.ship_via), destination: s(data.destination),
    hbl: s(data.hbl), container: s(data.container), etd: s(data.etd), eta: s(data.eta),
    deposit: s(data.deposit), currency: s(data.currency) || 'USD',
    lines: (data.lines || []).map((l) => ({
      po_no: s(l.po_no), style_no: s(l.style_no), style: s(l.style), size: s(l.size), color: s(l.color),
      description: s(l.description), composition: s(l.composition), fabric_weight: s(l.fabric_weight),
      total_carton: num(l.total_carton), unit_per_carton: num(l.unit_per_carton), qty: num(l.qty), unit_price: num(l.unit_price), notes: s(l.notes),
    })),
  };
}

/** 取 PI:有存过的返回存的;否则从生产单按款归组 + 客户PO价现算一份草稿。 */
export async function getPI(orderId: string): Promise<{ data?: PIBundle; error?: string }> {
  const { supabase, userId } = await auth();
  if (!userId) return { error: '请先登录' };

  const { data: order, error: oErr } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, po_number, factory_date, currency, eta').eq('id', orderId).maybeSingle();
  if (oErr) return { error: `读取订单失败:${oErr.message}` };
  if (!order) return { error: '订单不存在' };

  const { data: saved } = await (supabase.from('order_pi') as any).select('data').eq('order_id', orderId).maybeSingle();
  const savedData = (saved as any)?.data as PIData | undefined;
  if (savedData && Array.isArray(savedData.lines) && savedData.lines.length) {
    return { data: { ...cleanData(savedData), issuer: ISSUER, has_saved: true, order_no: (order as any).order_no ?? null } };
  }

  // 现算草稿:按款号归组(多颜色行并入一款)
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('style_no, product_name, product_name_en, color_cn, color_en, sizes, unit, qty_pcs, fabric_name, fabric_width, carton_count, po_unit_price, remark, line_no')
    .eq('order_id', orderId).order('line_no', { ascending: true });

  const poNo = (order as any).po_number || (order as any).order_no || '';
  const qtyOf = (l: any) => Number(l.qty_pcs) || Object.values(l.sizes && typeof l.sizes === 'object' ? l.sizes : {}).reduce((s: number, v: any) => s + (Number(v) || 0), 0);

  const groups = new Map<string, any[]>();
  for (const l of (lis || []) as any[]) {
    const key = l.style_no || `__l${l.line_no}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l);
  }
  const lines: PILine[] = [...groups.values()].map((rows) => {
    const first = rows[0];
    const unitLabel = first.unit && !/pcs|件/i.test(first.unit) ? 'SETS' : 'PCS';
    const totalQty = rows.reduce((s, l) => s + qtyOf(l), 0);
    const totalCarton = rows.reduce((s, l) => s + (Number(l.carton_count) || 0), 0);
    const color = rows.map((l) => {
      const nm = l.color_en || l.color_cn || '';
      const q = qtyOf(l);
      return q ? `${nm}(${q}${unitLabel})` : nm;
    }).filter(Boolean).join('\n');
    const sizeKeys = Object.keys(first.sizes && typeof first.sizes === 'object' ? first.sizes : {});
    return {
      po_no: poNo,
      style_no: first.style_no || '',
      style: first.product_name || '',
      size: sizeKeys.join('-'),
      color,
      description: first.product_name_en || first.product_name || '',
      composition: '',
      fabric_weight: '',
      total_carton: totalCarton,
      unit_per_carton: totalCarton > 0 ? Math.round(totalQty / totalCarton) : 0,
      qty: totalQty,
      unit_price: Number(first.po_unit_price) || 0,
      notes: first.fabric_name || first.remark || '',
    };
  });

  const now = new Date();
  const issueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const draft: PIData = {
    buyer_name: (order as any).customer_name || '',
    buyer_address: '', buyer_tel: '',
    invoice_no: '', issue_date: issueDate, ship_via: '', destination: '',
    hbl: '', container: '', etd: '', eta: (order as any).eta || (order as any).factory_date || '',
    deposit: '', currency: (order as any).currency || 'USD',
    lines: lines.length ? lines : [emptyLine()],
  };
  return { data: { ...draft, issuer: ISSUER, has_saved: false, order_no: (order as any).order_no ?? null } };
}

/** 保存 PI(业务改完存)。 */
export async function savePI(orderId: string, data: PIData): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_EDIT_PI.includes(r))) return { error: '仅业务/理单/管理员可编辑 PI' };
  const clean = cleanData(data);
  const { error } = await (supabase.from('order_pi') as any).upsert({ order_id: orderId, data: clean, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: 'order_id' });
  if (error) {
    if (/order_pi|does not exist|schema cache/i.test(error.message || '')) return { error: 'PI 表尚未建立:请先在 Supabase 执行 20260709_order_pi.sql' };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 导出 PI Excel(严格贴模板版式:14 列 A–N)。base64 供前端下载。 */
export async function exportPI(orderId: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: '请先登录' };
  const res = await getPI(orderId);
  if ((res as any).error || !res.data) return { error: (res as any).error || 'PI 数据为空' };
  const pi = res.data;

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('Invoice');
  // 列宽对齐模板:A12 B18 C18 D12 E30 F19 G15 H9 I9 J9 K9 L13 M13 N13
  ws.columns = [
    { width: 12 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 30 }, { width: 19 }, { width: 15 },
    { width: 9 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 13 }, { width: 13 }, { width: 13 },
  ];
  const bold = { bold: true } as any;
  const center = { horizontal: 'center', vertical: 'middle', wrapText: true } as any;
  const box = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } as any;

  // ── 抬头 ──
  ws.mergeCells('A1:N1'); ws.getCell('A1').value = ISSUER.company; ws.getCell('A1').font = { bold: true, size: 18 }; ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:N2'); ws.getCell('A2').value = ISSUER.address; ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.mergeCells('A3:N3'); ws.getCell('A3').value = ISSUER.contact; ws.getCell('A3').alignment = { horizontal: 'center' };
  ws.mergeCells('A4:N4'); ws.getCell('A4').value = ISSUER.title; ws.getCell('A4').font = { bold: true, size: 14 }; ws.getCell('A4').alignment = { horizontal: 'center' };

  // ── 买方 + 运输表头 ──
  ws.getCell('A5').value = `BUYER: ${pi.buyer_name || ''}`; ws.getCell('A5').font = bold;
  ws.getCell('J5').value = 'INVOICE NO:'; ws.getCell('J5').font = bold; ws.getCell('L5').value = pi.invoice_no || '';
  ws.getCell('A6').value = pi.buyer_address || '';
  ws.getCell('J6').value = `ISSUE DATE: ${pi.issue_date || ''}`;
  ws.getCell('A7').value = `TEL. ${pi.buyer_tel || ''}`;
  ws.getCell('J7').value = `SHIP VIA:${pi.ship_via || ''}`;
  ws.getCell('A8').value = `HBL#${pi.hbl || ''}`; ws.getCell('F8').value = `ETD ${pi.etd || ''}`; ws.getCell('J8').value = `DESTINATION:${pi.destination || ''}`;
  ws.getCell('A9').value = `CONTAINER#${pi.container || ''}`; ws.getCell('F9').value = `ETA ${pi.eta || ''}`;

  // ── 表头行(row 10) ──
  const HEAD = ['PO NO.', 'STYLE NO.', 'STYLE', 'SIZE', 'COLOR', 'DESCRIPTION', 'COMPOSITION', 'FABRIC WEIGHT', 'TOTAL CARTON', 'UNIT PER CARTON', 'QTY(SETS/PCS)', 'UNIT PRICE(USD) LDP', 'AMOUNT(USD)LDP', 'NOTES'];
  const HROW = 10;
  HEAD.forEach((h, i) => {
    const c = ws.getCell(HROW, i + 1);
    c.value = h; c.font = bold; c.alignment = center; c.border = box;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  ws.getRow(HROW).height = 34;

  // ── 明细行 ──
  let r = HROW + 1; let sumCarton = 0, sumQty = 0, sumAmount = 0;
  for (const ln of pi.lines) {
    const amount = Math.round((Number(ln.qty) || 0) * (Number(ln.unit_price) || 0) * 100) / 100;
    sumCarton += Number(ln.total_carton) || 0; sumQty += Number(ln.qty) || 0; sumAmount += amount;
    const vals: any[] = [ln.po_no, ln.style_no, ln.style, ln.size, ln.color, ln.description, ln.composition, ln.fabric_weight,
      Number(ln.total_carton) || 0, Number(ln.unit_per_carton) || 0, Number(ln.qty) || 0, Number(ln.unit_price) || 0, amount, ln.notes];
    vals.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; c.alignment = { vertical: 'middle', wrapText: true }; c.border = box; });
    // 行高按多行单元格(COLOR/DESCRIPTION/SIZE/COMPOSITION)最多行数撑开
    const maxLines = Math.max(1, ...[ln.color, ln.description, ln.size, ln.composition].map((t) => String(t || '').split('\n').length));
    ws.getRow(r).height = Math.max(20, maxLines * 15);
    r++;
  }
  // ── 合计行(对齐模板:I=箱数 K=数量 M=金额) ──
  sumAmount = Math.round(sumAmount * 100) / 100;
  ws.getCell(r, 1).value = 'TOTAL'; ws.getCell(r, 1).font = bold;
  const totalMap: Record<number, number> = { 9: sumCarton, 11: sumQty, 13: sumAmount };
  for (const col of [9, 11, 13]) { const c = ws.getCell(r, col); c.value = totalMap[col]; c.font = bold; }
  for (let col = 1; col <= 14; col++) ws.getCell(r, col).border = box;
  r++;

  // ── DEPOSIT 行(整行合并) ──
  ws.mergeCells(r, 1, r, 14);
  ws.getCell(r, 1).value = pi.deposit ? `DEPOSIT: ${pi.deposit}` : 'DEPOSIT';
  ws.getCell(r, 1).font = bold; ws.getCell(r, 1).border = box;

  const buf = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buf as ArrayBuffer).toString('base64');
  const fileName = `PI-${res.data.order_no || orderId}-${pi.invoice_no || pi.lines[0]?.po_no || ''}.xlsx`.replace(/[^\w.\-]/g, '_');
  return { base64, fileName };
}
