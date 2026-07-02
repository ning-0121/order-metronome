'use server';

/**
 * Manufacturing Order(生产任务单)—— O2 第一段。
 * Constitution:01 第3对象 / 02 单一真相(产品·数量·款色码·原辅料·交期 绑定不复制)/
 *   03 生命周期非复制 / 06 不接 AI / 07 只表达需求(无工艺/SMV/MES)/ 09 模板从结构化真相生成。
 * 红线:不接 AI、不动旧 legacy 生成器、不碰采购/B1/Material Package/procurement_line_items、无新 migration。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';

const MO_STATUSES = ['draft', 'reviewing', 'confirmed', 'executing', 'closed'] as const;
type MoStatus = typeof MO_STATUSES[number];

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};

export interface MoFields {
  print_embroidery_requirements?: string | null;
  qc_focus?: string | null;
  special_requirements?: string | null;
  risk_notes?: string | null;
  factory_packing_instructions?: string | null;
  factory_notes?: string | null;
}

/** 取生产任务单 + 绑定的 Customer Order / 款色码 / Material Package 摘要(组合,不复制)。 */
export async function getManufacturingOrder(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order, error: oErr } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, product_description, style_no, quantity, etd, factory_date, order_date, packaging_type, factory_name, owner_user_id')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('line_no, style_no, product_name, color_cn, color_en, sizes, unit, qty_pcs, image_url')
    .eq('order_id', orderId).order('line_no');

  const { data: bom } = await (supabase.from('materials_bom') as any)
    .select('material_name, material_type, material_code, color, placement, qty_per_piece, unit, supplier, special_requirements, material_master_id')
    .eq('order_id', orderId).order('material_type');

  return { data: { mo: mo || null, order, lineItems: lineItems || [], bom: bom || [] } };
}

/** 录入/保存生产任务单的 6 个翻译字段(无则建,自动赋 mo_no=MO-{order_no})。 */
export async function upsertManufacturingOrder(orderId: string, fields: MoFields) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const patch = {
    print_embroidery_requirements: fields.print_embroidery_requirements || null,
    qc_focus: fields.qc_focus || null,
    special_requirements: fields.special_requirements || null,
    risk_notes: fields.risk_notes || null,
    factory_packing_instructions: fields.factory_packing_instructions || null,
    factory_notes: fields.factory_notes || null,
  };

  const { data: existing } = await (supabase.from('manufacturing_orders') as any)
    .select('id').eq('order_id', orderId).maybeSingle();

  if (existing) {
    const { error } = await (supabase.from('manufacturing_orders') as any)
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('order_id', orderId);
    if (error) return { error: friendlyError(error) };
  } else {
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no').eq('id', orderId).single();
    const { error } = await (supabase.from('manufacturing_orders') as any).insert({
      order_id: orderId,
      mo_no: `MO-${(order as any)?.order_no || orderId.slice(0, 8)}`,
      ...patch,
      created_by: user.id,
    });
    if (error) return { error: friendlyError(error) };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 推进生命周期。confirmed→记内容确认留痕;executing→记下发工厂执行留痕(两者分开)。 */
export async function updateManufacturingOrderStatus(orderId: string, status: MoStatus) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!MO_STATUSES.includes(status)) return { error: '非法状态' };

  const { data: existing } = await (supabase.from('manufacturing_orders') as any)
    .select('id').eq('order_id', orderId).maybeSingle();
  if (!existing) return { error: '请先创建并保存生产任务单' };

  const now = new Date().toISOString();
  const upd: any = { status, updated_at: now };
  if (status === 'confirmed') { upd.confirmed_at = now; upd.confirmed_by = user.id; }
  if (status === 'executing') { upd.released_to_factory_at = now; upd.released_to_factory_by = user.id; }

  const { error } = await (supabase.from('manufacturing_orders') as any)
    .update(upd).eq('order_id', orderId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * 生成生产任务单 Excel(Constitution 09:数据全来自结构化真相 MO + orders + line_items + materials_bom)。
 * 不接 AI、不解析附件。返回 base64,前端转 Blob 下载。
 */
export async function generateManufacturingOrderSheet(
  orderId: string,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };

  const res = await getManufacturingOrder(orderId);
  if ((res as any).error) return { error: (res as any).error };
  const { mo, order, lineItems, bom } = (res as any).data;
  if (!mo) return { error: '请先创建并保存生产任务单' };

  // ── 名字解析(owner/confirmed/released → profiles.name)+ 格式化 ──
  const userIds = [order.owner_user_id, mo.confirmed_by, mo.released_to_factory_by, mo.created_by].filter(Boolean);
  const nameMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', userIds);
    for (const p of (profs || [])) nameMap[(p as any).user_id] = (p as any).name;
  }
  const nameOf = (uid: any) => (uid && nameMap[uid]) ? nameMap[uid] : '';
  const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : '');

  // ══ 生产任务单模板 V2(2026-07-02 自研,用户拍板结构):每款一个 sheet ══
  // 抬头 → 订单号/款号/该款数量 → 一、订单数量明细(件数+每箱件数+箱数公式+客户包装)
  // → 二、用料单耗(BOM 自动带出) → 三、装箱/包装/裁剪/缝制/检验/注意事项
  // → 四、尺寸表(留白,按建单上传的尺码表填) + 产品图片 → 抄送/签名
  const { sortSizeKeys: sortSizes } = await import('@/lib/utils/size-sort');

  // 按款分组(无明细则单 sheet 用订单头字段)
  const styleGroups: { style_no: string; product_name: string; image_url: string; items: any[] }[] = [];
  for (const li of lineItems) {
    const key = li.style_no || order.style_no || '';
    let g = styleGroups.find(x => x.style_no === key);
    if (!g) { g = { style_no: key, product_name: li.product_name || order.product_description || '', image_url: li.image_url || '', items: [] }; styleGroups.push(g); }
    if (!g.image_url && li.image_url) g.image_url = li.image_url;
    g.items.push(li);
  }
  if (styleGroups.length === 0) styleGroups.push({ style_no: order.style_no || '', product_name: order.product_description || '', image_url: '', items: [] });

  const joinTxt = (...vs: any[]) => vs.filter(Boolean).join('；');

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const FONT: any = { name: '宋体', size: 12 };
  const thin: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const COL = (n: number) => String.fromCharCode(64 + n); // 1→A …(总列数 ≤ 13,不会越界)

  // 产品图:公开桶 URL,服务端抓取失败不阻塞生成
  const fetchImage = async (url: string): Promise<{ buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | null> => {
    if (!url || !/^https?:\/\//.test(url)) return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const extension = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpeg';
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null;
      return { buffer, extension: extension as any };
    } catch { return null; }
  };

  for (const [gi, g] of styleGroups.entries()) {
    const sheetName = (g.style_no || `款${gi + 1}`).replace(/[\\/*?:[\]]/g, '_').slice(0, 28) || `款${gi + 1}`;
    const ws = wb.addWorksheet(wb.worksheets.some(w => w.name === sheetName) ? `${sheetName}_${gi + 1}` : sheetName);

    // 该款尺码集(至少留 3 个空位手填)
    const sizeSet = new Set<string>();
    for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
    const sizeKeys = sortSizes([...sizeSet]).slice(0, 8);
    const ns = Math.max(sizeKeys.length, 3);
    const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (styleGroups.length === 1 ? order.quantity : 0);

    // 列布局:A 标签/颜色 | B..(1+ns) 尺码 | 合计 | 每箱件数 | 箱数 | 客户包装
    const cTotal = 1 + ns + 1, cBox = cTotal + 1, cCarton = cBox + 1, cPack = cCarton + 1;
    const NC = cPack;
    ws.getColumn(1).width = 14;
    for (let c = 2; c <= 1 + ns; c++) ws.getColumn(c).width = 8.5;
    ws.getColumn(cTotal).width = 9;
    ws.getColumn(cBox).width = 10;
    ws.getColumn(cCarton).width = 8;
    ws.getColumn(cPack).width = 30;

    const put = (r: number, c: number, v: any, opt: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; formula?: string } = {}) => {
      const cell = ws.getCell(r, c);
      cell.value = opt.formula ? ({ formula: opt.formula } as any) : v;
      cell.font = { ...FONT, size: opt.size || 12, bold: !!opt.bold };
      cell.alignment = { horizontal: opt.align || 'center', vertical: 'middle', wrapText: !!opt.wrap };
      if (opt.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } };
    };
    const boxBorder = (r1: number, c1: number, r2: number, c2: number) => {
      for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) ws.getCell(rr, cc).border = thin;
    };
    const mergeR = (r: number, c1: number, c2: number) => { if (c2 > c1) ws.mergeCells(r, c1, r, c2); };
    const sec = (r: number, title: string) => {
      mergeR(r, 1, NC);
      put(r, 1, title, { bold: true, align: 'left', fill: 'FFEFEFEF' });
      boxBorder(r, 1, r, NC);
      ws.getRow(r).height = 22;
    };

    // ── 抬头 ──
    mergeR(1, 1, NC); put(1, 1, '义乌市绮陌服饰有限公司', { bold: true, size: 18 });
    ws.getRow(1).height = 26;
    mergeR(2, 1, NC); put(2, 1, '生 产 任 务 单', { size: 14, bold: true });
    ws.getRow(2).height = 20;

    // ── 订单头(3 行 × 3 组 kv;NC ≥ 8 保证布局)──
    const kv = (r: number, pairs: [string, any][]) => {
      put(r, 1, pairs[0][0], { bold: true }); mergeR(r, 2, 3); put(r, 2, pairs[0][1] ?? '', { align: 'left' });
      put(r, 4, pairs[1][0], { bold: true }); mergeR(r, 5, 6); put(r, 5, pairs[1][1] ?? '', { align: 'left' });
      put(r, 7, pairs[2][0], { bold: true }); mergeR(r, 8, NC); put(r, 8, pairs[2][1] ?? '', { align: 'left' });
      boxBorder(r, 1, r, NC);
      ws.getRow(r).height = 22;
    };
    kv(3, [['订单号', order.order_no], ['客户', order.customer_name], ['下单日期', fmtDate(order.order_date)]]);
    kv(4, [['款号', g.style_no], ['品名', g.product_name], ['该款数量', styleTotal ? `${styleTotal}件` : '']]);
    kv(5, [['工厂交期', fmtDate(order.factory_date)], ['发货日期(ETD)', fmtDate(order.etd)], ['制单日期', fmtDate(new Date().toISOString())]]);
    ws.getCell(4, 2).font = { ...FONT, bold: true };

    let row = 7;
    // ── 一、订单数量明细(件数 + 每箱件数 + 箱数公式 + 客户包装)──
    sec(row, '一、订单数量明细'); row++;
    const hd = row;
    put(hd, 1, '颜色', { bold: true, fill: 'FFFAFAFA' });
    for (let i = 0; i < ns; i++) put(hd, 2 + i, sizeKeys[i] || '', { bold: true, fill: 'FFFAFAFA' });
    put(hd, cTotal, '合计', { bold: true, fill: 'FFFAFAFA' });
    put(hd, cBox, '每箱件数', { bold: true, fill: 'FFFAFAFA' });
    put(hd, cCarton, '箱数', { bold: true, fill: 'FFFAFAFA' });
    put(hd, cPack, '客户包装', { bold: true, fill: 'FFFAFAFA' });
    row++;
    const firstColorRow = row;
    for (const li of g.items) {
      put(row, 1, [li.color_cn, li.color_en].filter(Boolean).join('/') || '—', {});
      sizeKeys.forEach((s, i) => {
        const q = li.sizes && typeof li.sizes === 'object' ? Number(li.sizes[s]) || 0 : 0;
        put(row, 2 + i, q || '', {});
      });
      put(row, cTotal, '', { formula: `SUM(B${row}:${COL(1 + ns)}${row})` });
      put(row, cCarton, '', { formula: `IF(${COL(cBox)}${row}>0,${COL(cTotal)}${row}/${COL(cBox)}${row},"")` });
      put(row, cPack, li.remark || '', { align: 'left', wrap: true });
      ws.getRow(row).height = 22;
      row++;
    }
    if (g.items.length === 0) { ws.getRow(row).height = 22; row++; } // 空一行手填
    const lastColorRow = row - 1;
    // 总计行
    put(row, 1, '总计', { bold: true });
    if (lastColorRow >= firstColorRow) {
      for (let i = 0; i < ns; i++) put(row, 2 + i, '', { formula: `SUM(${COL(2 + i)}${firstColorRow}:${COL(2 + i)}${lastColorRow})`, bold: true } as any);
      put(row, cTotal, '', { formula: `SUM(${COL(cTotal)}${firstColorRow}:${COL(cTotal)}${lastColorRow})`, bold: true } as any);
    }
    ws.getRow(row).height = 22;
    boxBorder(hd, 1, row, NC);
    row += 2;

    // ── 二、用料单耗(BOM;未录则留白手填)──
    sec(row, '二、用料单耗'); row++;
    const bh = row;
    put(bh, 1, '物料', { bold: true, fill: 'FFFAFAFA' });
    put(bh, 2, '类别', { bold: true, fill: 'FFFAFAFA' });
    put(bh, 3, '颜色', { bold: true, fill: 'FFFAFAFA' });
    put(bh, 4, '单耗/件', { bold: true, fill: 'FFFAFAFA' });
    put(bh, 5, '单位', { bold: true, fill: 'FFFAFAFA' });
    mergeR(bh, 6, NC); put(bh, 6, '备注', { bold: true, fill: 'FFFAFAFA' });
    row++;
    // S1.2 按款过滤:该款专属行(含同步的布料) + 整单通用行(style_no 空)
    const bomSorted = [...bom]
      .filter((b: any) => !b.style_no || b.style_no === g.style_no)
      .sort((a: any, b: any) => (a.material_type === 'fabric' ? 0 : 1) - (b.material_type === 'fabric' ? 0 : 1));
    if (bomSorted.length > 0) {
      for (const b of bomSorted) {
        put(row, 1, b.material_name || '', { align: 'left', wrap: true });
        put(row, 2, CAT_LABEL[b.material_type] || b.material_type || '', {});
        put(row, 3, b.color || '', {});
        put(row, 4, b.qty_per_piece ?? '', {});
        put(row, 5, b.unit || '', {});
        mergeR(row, 6, NC); put(row, 6, joinTxt(b.placement, b.special_requirements), { align: 'left', wrap: true });
        ws.getRow(row).height = 22;
        row++;
      }
    } else {
      for (let i = 0; i < 3; i++) { mergeR(row, 6, NC); ws.getRow(row).height = 22; row++; }
    }
    boxBorder(bh, 1, row - 1, NC);
    if (bomSorted.length === 0) {
      mergeR(row, 1, NC); put(row, 1, '（未录 BOM;在订单「原辅料和包装」录入后重新生成,可自动带出）', { align: 'left', size: 10 });
      row++;
    }
    row++;

    // ── 三、装箱 / 包装 / 工艺要求(空的留白手填)──
    sec(row, '三、装箱 · 包装 · 工艺要求'); row++;
    const reqRows: [string, string][] = [
      ['装箱方式', order.packaging_type === 'custom' ? '定制包装（按客户要求）' : '标准包装'],
      ['包装方式', mo.factory_packing_instructions || ''],
      ['裁剪要求', ''],
      ['缝制要求', joinTxt(mo.print_embroidery_requirements, mo.special_requirements)],
      ['检验要求', mo.qc_focus || ''],
      ['注意事项', joinTxt(mo.risk_notes, mo.factory_notes)],
    ];
    for (const [label, text] of reqRows) {
      mergeR(row, 1, 2); put(row, 1, label, { bold: true });
      mergeR(row, 3, NC); put(row, 3, text, { align: 'left', wrap: true });
      boxBorder(row, 1, row, NC);
      ws.getRow(row).height = text && text.length > 40 ? 48 : 24;
      row++;
    }
    row++;

    // ── 四、尺寸表(左) + 产品图片(右)──
    sec(row, '四、尺寸表（单位：CM · 按上传的尺码表填写）'); row++;
    const sh = row;
    put(sh, 1, '部位', { bold: true, fill: 'FFFAFAFA' });
    for (let i = 0; i < ns; i++) put(sh, 2 + i, sizeKeys[i] || '', { bold: true, fill: 'FFFAFAFA' });
    put(sh, cTotal, '公差', { bold: true, fill: 'FFFAFAFA' });
    const SIZE_ROWS = 10;
    for (let i = 0; i < SIZE_ROWS; i++) ws.getRow(sh + 1 + i).height = 22;
    boxBorder(sh, 1, sh + SIZE_ROWS, cTotal);
    // 产品图片区(右侧 3 列)
    ws.mergeCells(sh, cBox, sh + SIZE_ROWS, NC);
    put(sh, cBox, g.image_url ? '' : '产品图片', {});
    boxBorder(sh, cBox, sh + SIZE_ROWS, NC);
    const img = await fetchImage(g.image_url);
    if (img) {
      const imgId = wb.addImage({ buffer: img.buffer as any, extension: img.extension });
      ws.addImage(imgId, `${COL(cBox)}${sh}:${COL(NC)}${sh + SIZE_ROWS}`);
    }
    row = sh + SIZE_ROWS + 2;

    // ── 抄送 + 签名 ──
    mergeR(row, 1, NC);
    put(row, 1, `抄送:采购、面料仓、辅料仓${order.factory_name ? '、' + order.factory_name : ''}、QC、包装组长、打包组长`, { align: 'left', size: 10 });
    row++;
    put(row, 1, `制单：${nameOf(mo.created_by)}`, { align: 'left' });
    mergeR(row, 4, 5); put(row, 4, '跟单：', { align: 'left' });
    mergeR(row, 7, 8); put(row, 7, '批准：', { align: 'left' });
    ws.getRow(row).height = 24;
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
