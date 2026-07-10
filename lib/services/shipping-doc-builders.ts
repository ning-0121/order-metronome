/**
 * 出货单据 Excel 构建器(纯函数,不含鉴权/数据加载)——PL / CI / 报关 / PI 四张单的版式生成。
 * 下载入口(app/actions)与「出运完成同步财务」入口共用同一份构建器,保证下载件与推送件完全一致。
 * 数据来源:PL/CI/报关 走 ShippingDocModel(loadShippingDocModel);PI 走已保存的 PIData。
 */
import type { Workbook } from 'exceljs';
import type { ShippingDocModel } from './shipping-docs';
import type { PIData } from '@/app/actions/order-pi';

// PI 开票方固定抬头 · 义乌市绮陌服饰有限公司(与 order-pi.ts 同一常量,统一在此)
export const PI_ISSUER = {
  company: 'YIWU QIMO CLOTHING CO.,LTD（义乌市绮陌服饰有限公司）',
  address: '2108 Room, Global Building, No.168 Financial 6th Street, Yiwu City, Zhejiang Province, China',
  contact: 'CONTACT: ALEX QIN    TEL: 86-15924281155    FAX: 0579-81548728    EMAIL: ALEX@QIMOCLOTHING.COM',
  title: 'PROFORMA INVOICE',
};

/** Packing List(款×色逐行,箱数/毛重/体积按实发)。 */
export async function buildPackingListWorkbook(m: ShippingDocModel): Promise<Workbook> {
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
  return wb;
}

/** CI 商业发票(按款汇总,含客户成交价;调用方须确保 model 以 canSeeFin=true 装载)。 */
export async function buildCommercialInvoiceWorkbook(m: ShippingDocModel): Promise<Workbook> {
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

  mrg(1, 1, 1, N); cell(1, 1, seller.name_en, { size: 15, bold: true });
  mrg(2, 1, 2, N); cell(2, 1, `${seller.address_en}    TEL: ${seller.tel}    ${seller.email ? 'E: ' + seller.email : ''}`, { size: 9 });
  mrg(3, 1, 3, N); cell(3, 1, 'COMMERCIAL INVOICE', { size: 14, bold: true });
  mrg(4, 1, 4, 8); cell(4, 1, `BUYER: ${order.customer_name || ''}`, { size: 10, align: 'left' });
  mrg(4, 9, 4, N); cell(4, 9, `INVOICE NO.: ${plNumber}    ISSUE DATE: ${fmt(docMeta.issue_date) || fmt(order.etd) || ''}`, { size: 10, align: 'right' });
  mrg(5, 1, 5, 8); cell(5, 1, `SHIP VIA: ${docMeta.ship_via || ''}    DESTINATION: ${docMeta.destination || ''}`, { size: 10, align: 'left' });
  mrg(5, 9, 5, N); cell(5, 9, `HBL#: ${docMeta.hbl || ''}   CONTAINER#: ${docMeta.container_no || ''}   ETD ${fmt(docMeta.etd) || fmt(order.etd)}  ETA ${fmt(docMeta.eta)}`, { size: 9, align: 'right' });

  const HR = 7;
  const heads = ['PO NO.', 'STYLE NO.', 'STYLE', 'SIZE', 'COLOR', 'DESCRIPTION', 'COMPOSITION', 'FABRIC WEIGHT',
    'TOTAL CARTON', 'UNIT PER CARTON', `QTY(${'SETS/PCS'})`, `UNIT PRICE(${currency.label})`, `AMOUNT(${currency.label})`, 'NOTES'];
  heads.forEach((h, i) => cell(HR, i + 1, h, { bold: true, fill: 'FFF2F2F2', size: 8.5, border: true }));

  let r = HR + 1;
  for (const s of ciStyles) {
    const vals = [order.po_number || '', s.style_no, '', s.sizeRatio, s.colorBreakdown, s.description, s.composition, '',
      s.cartons || '', s.per || '', s.qty || '', s.unitPrice != null ? s.unitPrice : '', s.amount != null ? s.amount : '', ''];
    vals.forEach((v, i) => cell(r, i + 1, v, { size: 8.5, align: [4, 5, 6].includes(i) ? 'left' : 'center', border: true }));
    r++;
  }
  cell(r, 1, 'TOTAL', { bold: true, align: 'left', border: true });
  for (let c = 2; c <= N; c++) cell(r, c, '', { border: true });
  cell(r, 9, ciTotals.cartons || '', { bold: true, border: true });
  cell(r, 11, ciTotals.qty || '', { bold: true, border: true });
  cell(r, 13, ciTotals.amount || '', { bold: true, border: true });
  r++;

  const deposit = Number(docMeta.deposit) || 0;
  mrg(r, 1, r, 12); cell(r, 1, 'DEPOSIT', { align: 'left', bold: true, border: true }); cell(r, 13, deposit || '', { bold: true, border: true }); r++;
  mrg(r, 1, r, 12); cell(r, 1, 'BALANCE PAYMENT BEFORE DELIVERY', { align: 'left', bold: true, border: true });
  cell(r, 13, ciTotals.amount != null ? Math.round((ciTotals.amount - deposit) * 100) / 100 : '', { bold: true, border: true }); r += 2;

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
  return wb;
}

/** 报关资料(4 sheet:发票 + 箱单 + 合同 + 报关单;含成交价,调用方须以 canSeeFin=true 装载 model)。 */
export async function buildCustomsWorkbook(m: ShippingDocModel): Promise<Workbook> {
  const { order, seller, currency, docMeta, plNumber, ciStyles, ciTotals, plTotals } = m;
  const cz = docMeta.customs || {};
  const contractNo = cz.contract_no || (order.po_number ? `NO.${order.po_number}` : plNumber);
  const fmtCn = (d: any) => (d ? String(d).slice(0, 10).replace(/-/g, '.') : '');
  const invoiceDate = fmtCn(docMeta.issue_date || order.etd);
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

  const sellerHead = (ws: any, cell: any, _title: string, _docNo: string, cols: number) => {
    ws.mergeCells(1, 1, 1, cols); cell(1, 1, seller.name_cn, { size: 14, bold: true });
    ws.mergeCells(2, 1, 2, cols); cell(2, 1, seller.name_en, { size: 11, bold: true });
    ws.mergeCells(3, 1, 3, cols); cell(3, 1, seller.address_cn, { size: 9 });
    ws.mergeCells(4, 1, 4, cols); cell(4, 1, seller.address_en, { size: 9 });
    ws.mergeCells(5, 1, 5, cols); cell(5, 1, `Tel:${seller.tel}   Fax:${seller.fax}`, { size: 9 });
    ws.mergeCells(6, 1, 6, cols); cell(6, 1, _title, { size: 13, bold: true });
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
  return wb;
}

/** PI 形式发票(14 列 A–N,Jojo/绮陌抬头 + 合计 + DEPOSIT)。pi=已保存或现算的 PIData。 */
export async function buildPIWorkbook(pi: PIData, orderNoForName?: string | null): Promise<Workbook> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('Invoice');
  ws.columns = [
    { width: 12 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 30 }, { width: 19 }, { width: 15 },
    { width: 9 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 13 }, { width: 13 }, { width: 13 },
  ];
  const bold = { bold: true } as any;
  const center = { horizontal: 'center', vertical: 'middle', wrapText: true } as any;
  const box = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } as any;

  ws.mergeCells('A1:N1'); ws.getCell('A1').value = PI_ISSUER.company; ws.getCell('A1').font = { bold: true, size: 18 }; ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:N2'); ws.getCell('A2').value = PI_ISSUER.address; ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.mergeCells('A3:N3'); ws.getCell('A3').value = PI_ISSUER.contact; ws.getCell('A3').alignment = { horizontal: 'center' };
  ws.mergeCells('A4:N4'); ws.getCell('A4').value = PI_ISSUER.title; ws.getCell('A4').font = { bold: true, size: 14 }; ws.getCell('A4').alignment = { horizontal: 'center' };

  ws.getCell('A5').value = `BUYER: ${pi.buyer_name || ''}`; ws.getCell('A5').font = bold;
  ws.getCell('J5').value = 'INVOICE NO:'; ws.getCell('J5').font = bold; ws.getCell('L5').value = pi.invoice_no || '';
  ws.getCell('A6').value = pi.buyer_address || '';
  ws.getCell('J6').value = `ISSUE DATE: ${pi.issue_date || ''}`;
  ws.getCell('A7').value = `TEL. ${pi.buyer_tel || ''}`;
  ws.getCell('J7').value = `SHIP VIA:${pi.ship_via || ''}`;
  ws.getCell('A8').value = `HBL#${pi.hbl || ''}`; ws.getCell('F8').value = `ETD ${pi.etd || ''}`; ws.getCell('J8').value = `DESTINATION:${pi.destination || ''}`;
  ws.getCell('A9').value = `CONTAINER#${pi.container || ''}`; ws.getCell('F9').value = `ETA ${pi.eta || ''}`;

  const HEAD = ['PO NO.', 'STYLE NO.', 'STYLE', 'SIZE', 'COLOR', 'DESCRIPTION', 'COMPOSITION', 'FABRIC WEIGHT', 'TOTAL CARTON', 'UNIT PER CARTON', 'QTY(SETS/PCS)', 'UNIT PRICE(USD) LDP', 'AMOUNT(USD)LDP', 'NOTES'];
  const HROW = 10;
  HEAD.forEach((h, i) => {
    const c = ws.getCell(HROW, i + 1);
    c.value = h; c.font = bold; c.alignment = center; c.border = box;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  ws.getRow(HROW).height = 34;

  let r = HROW + 1; let sumCarton = 0, sumQty = 0, sumAmount = 0;
  for (const ln of pi.lines) {
    const amount = Math.round((Number(ln.qty) || 0) * (Number(ln.unit_price) || 0) * 100) / 100;
    sumCarton += Number(ln.total_carton) || 0; sumQty += Number(ln.qty) || 0; sumAmount += amount;
    const vals: any[] = [ln.po_no, ln.style_no, ln.style, ln.size, ln.color, ln.description, ln.composition, ln.fabric_weight,
      Number(ln.total_carton) || 0, Number(ln.unit_per_carton) || 0, Number(ln.qty) || 0, Number(ln.unit_price) || 0, amount, ln.notes];
    vals.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; c.alignment = { vertical: 'middle', wrapText: true }; c.border = box; });
    const maxLines = Math.max(1, ...[ln.color, ln.description, ln.size, ln.composition].map((t) => String(t || '').split('\n').length));
    ws.getRow(r).height = Math.max(20, maxLines * 15);
    r++;
  }
  sumAmount = Math.round(sumAmount * 100) / 100;
  ws.getCell(r, 1).value = 'TOTAL'; ws.getCell(r, 1).font = bold;
  const totalMap: Record<number, number> = { 9: sumCarton, 11: sumQty, 13: sumAmount };
  for (const col of [9, 11, 13]) { const c = ws.getCell(r, col); c.value = totalMap[col]; c.font = bold; }
  for (let col = 1; col <= 14; col++) ws.getCell(r, col).border = box;
  r++;

  ws.mergeCells(r, 1, r, 14);
  ws.getCell(r, 1).value = pi.deposit ? `DEPOSIT: ${pi.deposit}` : 'DEPOSIT';
  ws.getCell(r, 1).font = bold; ws.getCell(r, 1).border = box;
  void orderNoForName;
  return wb;
}
