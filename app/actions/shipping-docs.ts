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
export async function previewShippingDocs(orderId: string, batchId?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  const { data, error } = await loadShippingDocModel(supabase, orderId, canSeeFin, batchId);
  if (error) return { error };
  return { data };
}

/**
 * CI 商业发票生成(ExcelJS,绮陌抬头)。按款汇总;单价取客户 PO 价(po_unit_price,仅财务口径);
 * 币种可选(USD/RMB);页脚 = 定金/尾款 + 付款条件/运费/出厂日 + 银行信息(业务填,存 doc_meta)。
 */
export async function generateCommercialInvoice(
  orderId: string, batchId?: string | null,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  if (!canSeeFin) return { error: 'CI 含客户成交价,仅财务/业务/管理员可生成' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, true, batchId);
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

/**
 * 报关资料生成(ExcelJS,4 sheet:报关单 + 箱单 + 发票 + 合同,义乌绮陌自营出口)。
 * 海关字段(HS编码/报关品名/规格/监管方式/成交方式等)存 doc_meta.customs,业务填、给默认。
 */
export async function generateCustomsDocs(
  orderId: string, batchId?: string | null,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  if (!canSeeFin) return { error: '报关资料含成交价,仅财务/业务/管理员可生成' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, true, batchId);
  if (error || !m) return { error: error || '数据不足' };
  const { order, seller, currency, docMeta, plNumber, ciStyles, ciTotals, plTotals } = m;
  const cz = docMeta.customs || {};
  const contractNo = cz.contract_no || (order.po_number ? `NO.${order.po_number}` : plNumber);
  const fmtCn = (d: any) => (d ? String(d).slice(0, 10).replace(/-/g, '.') : '');
  const invoiceDate = fmtCn(docMeta.issue_date || order.etd);
  // 海关字段默认值(取自绮陌报关模板)
  const D = {
    overseas_buyer: cz.overseas_buyer || order.customer_name || '',
    overseas_addr: cz.overseas_addr || '', overseas_tel: cz.overseas_tel || '',
    customs_port: cz.customs_port || '宁波港', transport: cz.transport || '江海运输',
    supervision: cz.supervision || '一般贸易', levy_type: cz.levy_type || '一般征税',
    trade_country: cz.trade_country || '美国', dest_country: cz.dest_country || '美国',
    dest_port: cz.dest_port || '', exit_port: cz.exit_port || '',
    package_type: cz.package_type || '纸制或纤维板制盒/箱', trade_terms: docMeta.trade_terms || cz.trade_terms || 'FOB',
    origin_country: cz.origin_country || '中国', source_place: cz.source_place || seller.origin || '义乌',
    levy: cz.levy || '照章征税', price_terms: cz.price_terms || docMeta.freight || 'FOB',
  };
  const styleC = (s: string) => (cz.styles || {})[s] || {};

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const thin = { style: 'thin' as const };
  const B4: any = { top: thin, left: thin, bottom: thin, right: thin };
  const mk = (ws: any) => (r: number, c: number, v: any, o: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; border?: boolean } = {}) => {
    const x = ws.getCell(r, c); x.value = v ?? '';
    x.font = { name: '宋体', size: o.size ?? 10, bold: o.bold ?? false };
    x.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.border) x.border = { ...B4 };
  };

  // ── 绮陌抬头块(发票/箱单共用)──
  const sellerHead = (ws: any, cell: any, title: string, docNo: string, cols: number) => {
    ws.mergeCells(1, 1, 1, cols); cell(1, 1, seller.name_cn, { size: 14, bold: true });
    ws.mergeCells(2, 1, 2, cols); cell(2, 1, seller.name_en, { size: 11, bold: true });
    ws.mergeCells(3, 1, 3, cols); cell(3, 1, seller.address_cn, { size: 9 });
    ws.mergeCells(4, 1, 4, cols); cell(4, 1, seller.address_en, { size: 9 });
    ws.mergeCells(5, 1, 5, cols); cell(5, 1, `Tel:${seller.tel}   Fax:${seller.fax}`, { size: 9 });
    ws.mergeCells(6, 1, 6, cols); cell(6, 1, title, { size: 13, bold: true });
  };

  // ═══ Sheet 1:发票(报关专用) ═══
  {
    const ws = wb.addWorksheet('发票（报关专用）'); const cell = mk(ws);
    [6, 34, 10, 8, 12, 14, 16].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    sellerHead(ws, cell, 'INVOICE 发票', contractNo, 7);
    ws.mergeCells(7, 1, 7, 2); cell(7, 1, `INVOICE TO: ${D.overseas_buyer}`, { align: 'left' });
    cell(7, 6, 'INVOICE NO:', { align: 'right' }); cell(7, 7, contractNo, { align: 'left' });
    ws.mergeCells(8, 1, 8, 5); cell(8, 1, `ADDRESS: ${D.overseas_addr}`, { align: 'left', size: 9 });
    cell(8, 6, 'DATE:', { align: 'right' }); cell(8, 7, invoiceDate, { align: 'left' });
    const H = 9; ['NO.', 'GOOD DESCRIPTION & SPECIFICATION', 'Quantity', 'Unit', `UnitPrice(${currency.label})`, 'Amount', '款号'].forEach((h, i) => cell(H, i + 1, h, { bold: true, border: true, size: 9 }));
    let r = H + 1;
    ciStyles.forEach((s: any, i: number) => {
      const cn = styleC(s.style_no).customs_name || '女式针织便服套装';
      [i + 1, cn, s.qty, styleC(s.style_no).unit || (s.unitWord === 'SETS' ? '套' : 'PCS'), s.unitPrice ?? '', s.amount ?? '', s.style_no].forEach((v, c) => cell(r, c + 1, v, { border: true, size: 9, align: c === 1 ? 'left' : 'center' }));
      r++;
    });
    cell(r, 1, 'TOTAL', { bold: true, border: true }); for (let c = 2; c <= 7; c++) cell(r, c, '', { border: true });
    cell(r, 3, ciTotals.qty, { bold: true, border: true }); cell(r, 6, ciTotals.amount, { bold: true, border: true }); r += 2;
    ws.mergeCells(r, 3, r, 5); cell(r, 3, 'For and on behalf of', { align: 'center' }); r++;
    ws.mergeCells(r, 3, r, 5); cell(r, 3, seller.name_en, { align: 'center', bold: true });
  }

  // ═══ Sheet 2:箱单(报关专用) ═══
  {
    const ws = wb.addWorksheet('箱单（报关专用）'); const cell = mk(ws);
    [8, 26, 9, 7, 8, 10, 10, 9, 8, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    sellerHead(ws, cell, 'PACKING LIST 装箱单', contractNo, 10);
    ws.mergeCells(7, 1, 7, 3); cell(7, 1, `INVOICE TO: ${D.overseas_buyer}`, { align: 'left' });
    cell(7, 8, 'INVOICE NO:', { align: 'right' }); ws.mergeCells(7, 9, 7, 10); cell(7, 9, contractNo, { align: 'left' });
    cell(8, 8, 'DATE:', { align: 'right' }); ws.mergeCells(8, 9, 8, 10); cell(8, 9, invoiceDate, { align: 'left' });
    const H = 9; ['箱号\nCtn NO.', '品名及规格\nDESCRIPTION', '数量\nQty', '单位\nUnit', '箱数\nPKGS', '毛重(KGS)', '净重(KGS)', '体积(CBM)', '原产地', '款号'].forEach((h, i) => cell(H, i + 1, h, { bold: true, border: true, size: 8.5 }));
    let r = H + 1;
    ciStyles.forEach((s: any, i: number) => {
      const cn = styleC(s.style_no).customs_name || '女式针织便服套装';
      [i + 1, cn, s.qty, styleC(s.style_no).unit || '套', s.cartons, s.gross, s.net, s.vol, D.source_place, s.style_no].forEach((v, c) => cell(r, c + 1, v, { border: true, size: 8.5, align: c === 1 ? 'left' : 'center' }));
      r++;
    });
    cell(r, 1, 'TOTAL', { bold: true, border: true }); for (let c = 2; c <= 10; c++) cell(r, c, '', { border: true });
    cell(r, 3, ciTotals.qty, { bold: true, border: true }); cell(r, 5, plTotals.cartons, { bold: true, border: true });
    cell(r, 6, Math.round(plTotals.gross * 10) / 10, { bold: true, border: true }); cell(r, 7, Math.round(plTotals.net * 10) / 10, { bold: true, border: true });
    cell(r, 8, Math.round(plTotals.vol * 1000) / 1000, { bold: true, border: true }); cell(r, 9, D.source_place, { border: true });
  }

  // ═══ Sheet 3:合同(报关专用) ═══
  {
    const ws = wb.addWorksheet('合同（报关专用）'); const cell = mk(ws);
    [6, 30, 10, 8, 12, 14, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    ws.mergeCells(1, 1, 1, 7); cell(1, 1, '销售合同 SALES CONTRACT', { size: 13, bold: true });
    ws.mergeCells(2, 1, 2, 3); cell(2, 1, `日期(DATE)：${invoiceDate}`, { align: 'left' });
    ws.mergeCells(2, 4, 2, 7); cell(2, 4, `编号(CONTRACT NO.)：${contractNo}`, { align: 'left' });
    ws.mergeCells(3, 1, 3, 3); cell(3, 1, `买方(Buyer)：${D.overseas_buyer}`, { align: 'left' });
    ws.mergeCells(3, 4, 3, 7); cell(3, 4, `卖方(Seller)：${seller.name_cn}`, { align: 'left' });
    const H = 5; ['No.', '货物品名及规格\nDescription', '数量\nQty', '单位\nUnit', `单价(${currency.label})`, `总价(${currency.label})`, '款号'].forEach((h, i) => cell(H, i + 1, h, { bold: true, border: true, size: 9 }));
    let r = H + 1;
    ciStyles.forEach((s: any, i: number) => {
      const cn = styleC(s.style_no).customs_name || '女式针织便服套装';
      [i + 1, cn, s.qty, styleC(s.style_no).unit || '套', s.unitPrice ?? '', s.amount ?? '', s.style_no].forEach((v, c) => cell(r, c + 1, v, { border: true, size: 9, align: c === 1 ? 'left' : 'center' }));
      r++;
    });
    cell(r, 1, 'TOTAL', { bold: true, border: true }); for (let c = 2; c <= 7; c++) cell(r, c, '', { border: true });
    cell(r, 3, ciTotals.qty, { bold: true, border: true }); cell(r, 6, ciTotals.amount, { bold: true, border: true }); r += 2;
    const t = (label: string) => { ws.mergeCells(r, 1, r, 7); cell(r, 1, label, { align: 'left', size: 9 }); r++; };
    t(`1. 价格条款(Terms)：${D.price_terms}    2. 包装(Packing)：${D.package_type}`);
    t(`3. 运抵国/地区(Destination)：${D.dest_country}    4. 指运港(Port)：${D.dest_port}`);
    t(`5. 成交方式：${D.trade_terms}    6. 结汇方式(Payment)：${docMeta.payment_terms || ''}`);
    r++; ws.mergeCells(r, 1, r, 3); cell(r, 1, `买方(Buyer)：${D.overseas_buyer}`, { align: 'left' });
    ws.mergeCells(r, 4, r, 7); cell(r, 4, `卖方(Seller)：${seller.name_cn}`, { align: 'left' });
  }

  // ═══ Sheet 4:新版报关单 ═══
  {
    const ws = wb.addWorksheet('新版报关单'); const cell = mk(ws);
    [10, 10, 10, 22, 12, 10, 10, 12, 10].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    ws.mergeCells(1, 1, 1, 9); cell(1, 1, '中华人民共和国海关出口货物报关单', { size: 13, bold: true });
    const kv = (r: number, pairs: Array<[string, any]>) => {
      const span = Math.floor(9 / pairs.length);
      pairs.forEach(([k, v], i) => {
        const c1 = i * span + 1; const c2 = i === pairs.length - 1 ? 9 : (i + 1) * span;
        ws.mergeCells(r, c1, r, c2); cell(r, c1, `${k}：${v ?? ''}`, { align: 'left', size: 9, border: true });
      });
    };
    kv(2, [['境内发货人', seller.name_cn], ['出境关别', D.customs_port], ['申报日期', invoiceDate]]);
    kv(3, [['统一社会信用代码', seller.usci], ['运输方式', D.transport], ['提运单号', docMeta.hbl || '']]);
    kv(4, [['境外收货人', D.overseas_buyer], ['监管方式', D.supervision], ['征免性质', D.levy_type]]);
    kv(5, [['生产销售单位', seller.name_cn], ['合同协议号', contractNo], ['备案号', '']]);
    kv(6, [['贸易国(地区)', D.trade_country], ['运抵国(地区)', D.dest_country], ['指运港', D.dest_port]]);
    kv(7, [['离境口岸', D.exit_port], ['成交方式', D.trade_terms], ['运费/保费', `${docMeta.freight || ''}`]]);
    kv(8, [['包装种类', D.package_type], ['件数', plTotals.cartons], ['毛重(千克)', Math.round(plTotals.gross * 10) / 10]]);
    kv(9, [['净重(千克)', Math.round(plTotals.net * 10) / 10], ['币制', currency.label], ['境内货源地', D.source_place]]);
    const H = 11; ['项号', '商品编号(HS)', '商品名称', '规格型号', '数量及单位', `单价/总价/币制`, '原产国', '最终目的国', '征免'].forEach((h, i) => cell(H, i + 1, h, { bold: true, border: true, fill: 'FFF2F2F2', size: 8.5 }));
    let r = H + 1;
    ciStyles.forEach((s: any, i: number) => {
      const sc = styleC(s.style_no);
      const unit = sc.unit || '套';
      [i + 1, sc.hs_code || '', sc.customs_name || '女式针织便服套装', sc.customs_spec || '',
        `${s.qty}${unit}`, `${s.unitPrice ?? ''}/${s.amount ?? ''}/${currency.label}`,
        D.origin_country, D.dest_country, D.levy].forEach((v, c) => cell(r, c + 1, v, { border: true, size: 8.5, align: c === 2 || c === 3 ? 'left' : 'center' }));
      r++;
    });
  }

  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `报关资料 - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
