'use server';

import { createClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { loadShippingDocModel } from '@/lib/services/shipping-docs';

async function canSeeFinOf(supabase: any, userId: string): Promise<boolean> {
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
}

/** 单据预览(PL + CI 结构化数据,供 UI 渲染 HTML 预览)。价列仅财务口径可见。 */
export async function previewShippingDocs(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  const { data, error } = await loadShippingDocModel(supabase, orderId, canSeeFin);
  if (error) return { error };
  return { data };
}

/**
 * CI 商业发票生成(ExcelJS,绮陌抬头)。按款汇总;单价取客户 PO 价(po_unit_price,仅财务口径);
 * 币种可选(USD/RMB);页脚 = 定金/尾款 + 付款条件/运费/出厂日 + 银行信息(业务填,存 doc_meta)。
 */
export async function generateCommercialInvoice(
  orderId: string,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  if (!canSeeFin) return { error: 'CI 含客户成交价,仅财务/业务/管理员可生成' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, true);
  if (error || !m) return { error: error || '数据不足' };
  const { order, seller, currency, docMeta, plNumber, ciStyles, ciTotals } = m;
  const bank = docMeta.bank || {};
  const fmt = (d: any) => (d ? String(d).slice(0, 10) : '');

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('COMMERCIAL INVOICE');
  const thin = { style: 'thin' as const };
  const B4: any = { top: thin, left: thin, bottom: thin, right: thin };
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.3, header: 0, footer: 0 } };
  const COLW = [11, 14, 8, 12, 18, 18, 16, 10, 9, 10, 11, 13, 13, 12];
  COLW.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const cell = (r: number, c: number, v: any, o: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; border?: boolean } = {}) => {
    const x = ws.getCell(r, c);
    x.value = v ?? '';
    x.font = { name: 'Arial', size: o.size ?? 10, bold: o.bold ?? false };
    x.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.border) x.border = { ...B4 };
    return x;
  };
  const mrg = (a: number, b: number, c: number, d: number) => ws.mergeCells(a, b, c, d);
  const N = 14;

  // ── 抬头 ──
  mrg(1, 1, 1, N); cell(1, 1, seller.name_en, { size: 15, bold: true });
  mrg(2, 1, 2, N); cell(2, 1, `${seller.address_en}    TEL: ${seller.tel}    ${seller.email ? 'E: ' + seller.email : ''}`, { size: 9 });
  mrg(3, 1, 3, N); cell(3, 1, 'COMMERCIAL INVOICE', { size: 14, bold: true });
  mrg(4, 1, 4, 8); cell(4, 1, `BUYER: ${order.customer_name || ''}`, { size: 10, align: 'left' });
  mrg(4, 9, 4, N); cell(4, 9, `INVOICE NO.: ${plNumber}    ISSUE DATE: ${fmt(docMeta.issue_date) || fmt(order.etd) || ''}`, { size: 10, align: 'right' });
  mrg(5, 1, 5, 8); cell(5, 1, `SHIP VIA: ${docMeta.ship_via || ''}    DESTINATION: ${docMeta.destination || ''}`, { size: 10, align: 'left' });
  mrg(5, 9, 5, N); cell(5, 9, `HBL#: ${docMeta.hbl || ''}   CONTAINER#: ${docMeta.container_no || ''}   ETD ${fmt(docMeta.etd) || fmt(order.etd)}  ETA ${fmt(docMeta.eta)}`, { size: 9, align: 'right' });

  // ── 表头(第7行)──
  const HR = 7;
  const heads = ['PO NO.', 'STYLE NO.', 'STYLE', 'SIZE', 'COLOR', 'DESCRIPTION', 'COMPOSITION', 'FABRIC WEIGHT',
    'TOTAL CARTON', 'UNIT PER CARTON', `QTY(${'SETS/PCS'})`, `UNIT PRICE(${currency.label})`, `AMOUNT(${currency.label})`, 'NOTES'];
  heads.forEach((h, i) => cell(HR, i + 1, h, { bold: true, fill: 'FFF2F2F2', size: 8.5, border: true }));

  // ── 数据行(按款)──
  let r = HR + 1;
  for (const s of ciStyles) {
    const vals = [order.po_number || '', s.style_no, '', s.sizeRatio, s.colorBreakdown, s.description, s.composition, '',
      s.cartons || '', s.per || '', s.qty || '', s.unitPrice != null ? s.unitPrice : '', s.amount != null ? s.amount : '', ''];
    vals.forEach((v, i) => cell(r, i + 1, v, { size: 8.5, align: [4, 5, 6].includes(i) ? 'left' : 'center', border: true }));
    r++;
  }
  // 合计
  cell(r, 1, 'TOTAL', { bold: true, align: 'left', border: true });
  for (let c = 2; c <= N; c++) cell(r, c, '', { border: true });
  cell(r, 9, ciTotals.cartons || '', { bold: true, border: true });
  cell(r, 11, ciTotals.qty || '', { bold: true, border: true });
  cell(r, 13, ciTotals.amount || '', { bold: true, border: true });
  const totalRow = r;
  r++;

  // ── 定金 / 尾款 ──
  const deposit = Number(docMeta.deposit) || 0;
  mrg(r, 1, r, 12); cell(r, 1, 'DEPOSIT', { align: 'left', bold: true, border: true }); cell(r, 13, deposit || '', { bold: true, border: true }); r++;
  mrg(r, 1, r, 12); cell(r, 1, 'BALANCE PAYMENT BEFORE DELIVERY', { align: 'left', bold: true, border: true });
  cell(r, 13, ciTotals.amount != null ? Math.round((ciTotals.amount - deposit) * 100) / 100 : '', { bold: true, border: true }); r += 2;

  // ── 条款 + 银行 ──
  const line = (label: string) => { mrg(r, 1, r, N); cell(r, 1, label, { align: 'left', size: 10 }); r++; };
  line('TERMS AND OTHER CONDITIONS:');
  line(`1. PAYMENT TERMS: ${docMeta.payment_terms || ''}`);
  line(`2. FREIGHT: ${docMeta.freight || ''}`);
  line(`3. EXIT FACTORY DATE: ${fmt(docMeta.exit_factory_date)}`);
  line('4. BANK INFORMATION:');
  line(`BENEFICIARY'S BANK: ${bank.beneficiary_bank || ''}`);
  line(`SWIFT BIC: ${bank.swift || ''}`);
  line(`BANK ADD: ${bank.bank_address || ''}`);
  line(`BENEFICIARY NAME: ${bank.beneficiary_name || ''}`);
  line(`ROUTING NO.: ${bank.routing_no || ''}`);
  line(`ACCOUNT NO.: ${bank.account_no || ''}`);
  line(`COMPANY ADD: ${bank.company_address || ''}`);
  void totalRow;

  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `CI - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
