'use server';

/**
 * 订单 PI(形式发票 Proforma Invoice)· 生成 / 保存 / 导出(2026-07-09 用户)。
 * 生成:从「生产单(逐款明细 order_line_items)」带款/色/面料/数量,FOB 取客户 PO 成交价(po_unit_price),
 *      交期取出厂日,买方取客户 → PI 草稿。业务可改价/折扣/交期/买方,存 order_pi(jsonb)。
 * 卖方公司+银行是固定常量(下方 SELLER),不入库。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const CAN_EDIT_PI = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

// 卖方固定信息(取自绮陌 PI 样板)
const SELLER = {
  title: 'Proforma Invoice',
  company: 'YIWU QIMO CLOTHING CO.,LTD',
  name: 'Yiwu Qimo Clothing Company, Ltd',
  address: '2108, Global Building, No.168 Finance Sixth Street, Yiwu city, Zhejiang Province, China,322000',
  tel: '(+86)15857944126',
  fax: '0579-81548728',
  bank: `RECEIVING U.S.DOLLAR PAYMENT AT BANK OF RUIFENG

RECEIVING U.S.DOLLAR PAYMENT IN CHINA CAN BE EASY. PLEASE REQUEST THE REMITTER TO INSTRUCT THE REMITTING BANK TO USE THE FOLLOWING PAYMENT ROUTE:

56a:INTERMEDIARY BANK:
(CORRESPONDENT OF BENEFICIARY'S BANK ) (收款人银行之代理行) CITIBANK N.A.NEW YORK
SWIFT BIC：CITIUS33
57a:ACCOUNT WITH INSTITUTION:
（BENEFICIARY'S BANK）（收款人银行） ZHEJIANG RURAL COMMERCIAL UNITED BANK CO.,LTD
SWIFT BIC：ZJRCCN2N
ADD. NO509 NORTH GONGREN ROAD  YIWU CITY ZHEJIANG CHINA
59a:BENEFICIARY:（收款人） ACCOUNT NUMBER：201000416619846 (帐    号)
NAME：Yiwu Qimo Clothing Co., Ltd(账户名称）
ADD:ROOM 2108,21F GLOBAL BUILDING,NO.168,FINANCIAL SIXTH STREET,FUTIAN STREET,YIWU CITY,ZHEJIANG PROVINCE,CHINA`,
};

export interface PILine { style_no: string; color: string; fabric: string; qty: number; fob: number }
export interface PIData {
  buyer_name: string; buyer_address: string; buyer_tel: string;
  contract_no: string; ready_to_ship: string; discount_pct: number; currency: string;
  lines: PILine[];
}

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles };
}

/** 取 PI:有存过的返回存的;否则从生产单+客户PO价+出厂日现算一份草稿。 */
export async function getPI(orderId: string): Promise<{ data?: PIData & { seller: typeof SELLER; has_saved: boolean; order_no: string | null }; error?: string }> {
  const { supabase, userId } = await auth();
  if (!userId) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, customer_po_number, factory_date, currency').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };

  const { data: saved } = await (supabase.from('order_pi') as any).select('data').eq('order_id', orderId).maybeSingle();
  const savedData = (saved as any)?.data as PIData | undefined;
  if (savedData && Array.isArray(savedData.lines) && savedData.lines.length) {
    return { data: { ...savedData, seller: SELLER, has_saved: true, order_no: (order as any).order_no ?? null } };
  }

  // 现算草稿:逐款×逐色
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('style_no, color_cn, color_en, sizes, qty_pcs, fabric_name, po_unit_price, line_no')
    .eq('order_id', orderId).order('line_no', { ascending: true });
  const lines: PILine[] = ((lis || []) as any[]).map((l) => {
    const sz = l.sizes && typeof l.sizes === 'object' ? l.sizes : {};
    const qty = Number(l.qty_pcs) || Object.values(sz).reduce((s: number, v: any) => s + (Number(v) || 0), 0);
    return {
      style_no: l.style_no || '',
      color: l.color_en || l.color_cn || '',
      fabric: l.fabric_name || '',
      qty: qty || 0,
      fob: Number(l.po_unit_price) || 0,
    };
  });

  const draft: PIData = {
    buyer_name: (order as any).customer_name || '',
    buyer_address: '', buyer_tel: '',
    contract_no: (order as any).customer_po_number || (order as any).order_no || '',
    ready_to_ship: (order as any).factory_date || '',
    discount_pct: 0,
    currency: (order as any).currency || 'USD',
    lines,
  };
  return { data: { ...draft, seller: SELLER, has_saved: false, order_no: (order as any).order_no ?? null } };
}

/** 保存 PI(业务改完存)。 */
export async function savePI(orderId: string, data: PIData): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_EDIT_PI.includes(r))) return { error: '仅业务/理单/管理员可编辑 PI' };
  const clean: PIData = {
    buyer_name: String(data.buyer_name || ''), buyer_address: String(data.buyer_address || ''), buyer_tel: String(data.buyer_tel || ''),
    contract_no: String(data.contract_no || ''), ready_to_ship: String(data.ready_to_ship || ''),
    discount_pct: Number(data.discount_pct) || 0, currency: String(data.currency || 'USD'),
    lines: (data.lines || []).map((l) => ({ style_no: String(l.style_no || ''), color: String(l.color || ''), fabric: String(l.fabric || ''), qty: Number(l.qty) || 0, fob: Number(l.fob) || 0 })),
  };
  const { error } = await (supabase.from('order_pi') as any).upsert({ order_id: orderId, data: clean, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: 'order_id' });
  if (error) {
    if (/order_pi|does not exist|schema cache/i.test(error.message || '')) return { error: 'PI 表尚未建立:请先在 Supabase 执行 20260709_order_pi.sql' };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 导出 PI Excel(贴样板版式)。base64 供前端下载。 */
export async function exportPI(orderId: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: '请先登录' };
  const res = await getPI(orderId);
  if ((res as any).error || !res.data) return { error: (res as any).error || 'PI 数据为空' };
  const pi = res.data;

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('PI');
  ws.columns = [{ width: 14 }, { width: 16 }, { width: 14 }, { width: 24 }, { width: 12 }, { width: 10 }, { width: 14 }];
  const bold = { bold: true } as any;

  ws.mergeCells('A1:G1'); ws.getCell('A1').value = SELLER.title; ws.getCell('A1').font = { bold: true, size: 16 }; ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:G2'); ws.getCell('A2').value = SELLER.company; ws.getCell('A2').font = { bold: true, size: 12 }; ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getCell('A3').value = 'Buyer:'; ws.getCell('B3').value = pi.buyer_name;
  ws.getCell('F3').value = 'PURCHASE CONTRACT#'; ws.getCell('F3').font = bold; ws.getCell('G3').value = pi.contract_no;
  ws.getCell('A4').value = 'Postal Add:'; ws.getCell('B4').value = pi.buyer_address;
  ws.getCell('A5').value = 'TEL:'; ws.getCell('B5').value = pi.buyer_tel;
  ws.getCell('A7').value = 'Seller:'; ws.getCell('B7').value = SELLER.name;
  ws.getCell('A8').value = 'Postal Add:'; ws.getCell('B8').value = SELLER.address;
  ws.getCell('A9').value = 'TEL:'; ws.getCell('B9').value = SELLER.tel;
  ws.getCell('A10').value = 'FAX:'; ws.getCell('B10').value = SELLER.fax;

  const hdr = 12;
  ['PICTURES', 'STYLE #', 'COLOR', 'FABRIC', 'Quantity（PCS）', 'FOB', `AMOUNT (${pi.currency})`].forEach((h, i) => {
    const c = ws.getCell(hdr, i + 1); c.value = h; c.font = bold; c.alignment = { horizontal: 'center', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  let r = hdr + 1; let total = 0;
  for (const ln of pi.lines) {
    const amount = Math.round((Number(ln.qty) || 0) * (Number(ln.fob) || 0) * 100) / 100;
    total += amount;
    ws.getCell(r, 2).value = ln.style_no; ws.getCell(r, 3).value = ln.color; ws.getCell(r, 4).value = ln.fabric;
    ws.getCell(r, 5).value = Number(ln.qty) || 0; ws.getCell(r, 6).value = Number(ln.fob) || 0; ws.getCell(r, 7).value = amount;
    ws.getRow(r).alignment = { vertical: 'middle', wrapText: true };
    r++;
  }
  total = Math.round(total * 100) / 100;
  const disc = Math.round(total * (Number(pi.discount_pct) || 0)) / 100;
  const net = Math.round((total - disc) * 100) / 100;
  ws.getCell(r, 1).value = 'TOTAL'; ws.getCell(r, 1).font = bold; ws.getCell(r, 7).value = total; ws.getCell(r, 7).font = bold; r++;
  ws.getCell(r, 1).value = `Less ${pi.discount_pct || 0}% Discount`; ws.getCell(r, 7).value = disc; r++;
  ws.getCell(r, 1).value = 'Net Amount'; ws.getCell(r, 1).font = bold; ws.getCell(r, 7).value = net; ws.getCell(r, 7).font = bold; r += 2;

  ws.getCell(r, 1).value = 'TERMS AND OTHER CONDITIONS:'; ws.getCell(r, 1).font = bold; r++;
  ws.getCell(r, 1).value = `READY TO SHIP DATE: ${pi.ready_to_ship || ''}`; r++;
  ws.mergeCells(r, 1, r, 7); const bc = ws.getCell(r, 1); bc.value = SELLER.bank; bc.alignment = { wrapText: true, vertical: 'top' }; ws.getRow(r).height = 200; r += 2;
  ws.getCell(r, 1).value = 'Authorized Signature (s)'; ws.getCell(r, 5).value = 'Authorized Signature (s)';

  const buf = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buf as ArrayBuffer).toString('base64');
  const fileName = `PI-${res.data.order_no || orderId}-${pi.contract_no || ''}.xlsx`.replace(/[^\w.\-]/g, '_');
  return { base64, fileName };
}
