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
    .select('id, order_no, customer_name, product_description, style_no, quantity, etd, factory_date, packaging_type, factory_name, owner_user_id')
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

  // ══ 按范本《生产任务单范本.xlsx》生成:每款一个 sheet,A-K 共 11 列,宋体 14 ══
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

  // 范本尺码明细表左列(工厂手填数值;标签沿用范本)
  const MEASURE_LABELS = [
    '胸围(缝下1")', '肩带宽', '肩宽', '前胸宽（高肩点下5"）', '后胸宽（高肩点下5"）', '肩斜', '领宽',
    '前领深', '后领深', '袖笼直量', '腰围（高肩点下15"）', '下摆', '前总长（从高肩点）', '内衬前中长',
  ];

  const fabrics = bom.filter((b: any) => b.material_type === 'fabric');
  const fabricText = (f: any) => f ? [f.material_name, f.color].filter(Boolean).join(' ') : '';
  const fabricUsage = (f: any) => (f && f.qty_per_piece != null) ? `${f.qty_per_piece}${f.unit || ''}/件` : '';
  const bomJoin = (types: string[]) => bom
    .filter((b: any) => types.includes(b.material_type))
    .map((b: any) => [b.material_name, b.color, b.qty_per_piece != null ? `${b.qty_per_piece}${b.unit || ''}/件` : ''].filter(Boolean).join(' '))
    .join('；');
  const joinTxt = (...vs: any[]) => vs.filter(Boolean).join('；');

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const FONT: any = { name: '宋体', size: 14 };
  const thin: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const COL = (n: number) => String.fromCharCode(64 + n); // 1→A … 11→K

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
    ws.getColumn(1).width = 21;
    for (let c = 2; c <= 11; c++) ws.getColumn(c).width = 10.6;

    // 该款尺码集 + 数量矩阵
    const sizeSet = new Set<string>();
    for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
    const sizeKeys = sortSizes([...sizeSet]).slice(0, 10);
    const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (styleGroups.length === 1 ? order.quantity : 0);

    // 通用写格
    const put = (addr: string, v: any, opt: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right'; wrap?: boolean; border?: boolean; formula?: string } = {}) => {
      const cell = ws.getCell(addr);
      cell.value = opt.formula ? ({ formula: opt.formula } as any) : v;
      cell.font = { ...FONT, size: opt.size || 14, bold: !!opt.bold };
      cell.alignment = { horizontal: opt.align || 'center', vertical: 'middle', wrapText: !!opt.wrap };
      if (opt.border) cell.border = thin;
    };
    const boxBorder = (r1: number, c1: number, r2: number, c2: number) => {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = thin;
    };

    // ── 头部(范本 1-3 行)──
    ws.mergeCells('A1:K1'); put('A1', '义乌市绮陌服饰有限公司', { bold: true, size: 22 });
    ws.getRow(1).height = 27;
    ws.mergeCells('A2:K2'); put('A2', '生产任务单', {});
    ws.getRow(2).height = 22;
    put('A3', '订单号：', { align: 'right' });
    ws.mergeCells('B3:C3'); put('B3', order.order_no || '', { align: 'left' });
    put('D3', '总数量:', { align: 'right' });
    ws.mergeCells('E3:F3'); put('E3', styleTotal ? `${styleTotal}件` : '', { align: 'left' });
    put('G3', '制单日期：', { align: 'right' });
    put('H3', fmtDate(new Date().toISOString()), { align: 'left' });
    put('I3', '发货日期：', { align: 'right' });
    ws.mergeCells('J3:K3'); put('J3', fmtDate(order.etd), { align: 'left' });
    for (let c = 1; c <= 11; c++) ws.getCell(3, c).border = { bottom: { style: 'thin' } } as any;

    // ── 款号/品名/面料(范本 4-6 行)──
    put('A4', '款    号', { border: true });
    ws.mergeCells('B4:F4'); put('B4', g.style_no, { bold: true });
    put('G4', '品    名', { border: true });
    ws.mergeCells('H4:K4'); put('H4', g.product_name, {});
    put('A5', '主 面 料', { border: true });
    ws.mergeCells('B5:F5'); put('B5', fabricText(fabrics[0]), {});
    put('G5', '网    纱', { border: true });
    ws.mergeCells('H5:K5'); put('H5', fabricText(fabrics[1]), {});
    put('A6', '主面料用料', { border: true });
    ws.mergeCells('B6:F6'); put('B6', fabricUsage(fabrics[0]), {});
    put('G6', '网纱用料', { border: true });
    ws.mergeCells('H6:K6'); put('H6', fabricUsage(fabrics[1]), {});
    boxBorder(4, 1, 6, 11);

    // ── 尺码明细表 + 产品图片(范本 7-23 行)──
    put('A7', '分    类', { border: true });
    ws.mergeCells('B7:G7'); put('B7', '尺码明细表单位：CM', {});
    ws.mergeCells('H7:K7'); put('H7', '产品图片', {});
    put('A8', '尺    码', {});
    sizeKeys.slice(0, 5).forEach((s, i) => put(`${COL(2 + i)}8`, s, {}));
    put('G8', '公差', {});
    MEASURE_LABELS.forEach((label, i) => put(`A${9 + i}`, label, {}));
    put('A23', '胸垫型号', {});
    boxBorder(7, 1, 23, 7);
    boxBorder(7, 8, 7, 11);
    ws.mergeCells('H8:K23');
    boxBorder(8, 8, 23, 11);
    for (let r = 4; r <= 23; r++) ws.getRow(r).height = 25;

    // 嵌产品图(取不到就留空白区)
    const img = await fetchImage(g.image_url);
    if (img) {
      const imgId = wb.addImage({ buffer: img.buffer as any, extension: img.extension });
      ws.addImage(imgId, 'H8:K23');
    }

    // ── 颜色 × 订单数量矩阵(范本 24-29 行,动态多颜色)──
    // 尺码槽位:B..K 共 10 列均分
    const n = Math.max(sizeKeys.length, 1);
    const base = Math.floor(10 / n), rem = 10 % n;
    let cur = 2;
    const slots: { start: number; end: number }[] = [];
    for (let i = 0; i < n; i++) { const w = base + (i < rem ? 1 : 0); slots.push({ start: cur, end: cur + w - 1 }); cur += w; }
    const mergeSlotRow = (r: number) => slots.forEach(s => { if (s.end > s.start) ws.mergeCells(r, s.start, r, s.end); });

    let row = 24;
    ws.mergeCells(`A24:A26`); put('A24', '颜色', {});
    ws.mergeCells(`B24:K24`); put('B24', '订单数量', {});
    row = 25;
    mergeSlotRow(25);
    sizeKeys.forEach((s, i) => put(`${COL(slots[i].start)}25`, s, {}));
    row = 26;
    for (const [ci, li] of g.items.entries()) {
      const skuRow = ci === 0 ? 26 : row; // 第一个颜色的 SKU 行在 A24:A26 合并区内
      if (ci > 0) put(`A${skuRow}`, '', {});
      mergeSlotRow(skuRow);
      sizeKeys.forEach((s, i) => put(`${COL(slots[i].start)}${skuRow}`, `${g.style_no}${(li.color_en || '').toUpperCase()}${s}`, {}));
      row = skuRow + 1;
      const qtyRow = row;
      put(`A${qtyRow}`, [li.color_cn, li.color_en].filter(Boolean).join('/') || '—', {});
      mergeSlotRow(qtyRow);
      sizeKeys.forEach((s, i) => {
        const q = li.sizes && typeof li.sizes === 'object' ? Number(li.sizes[s]) || 0 : 0;
        put(`${COL(slots[i].start)}${qtyRow}`, q || '', {});
      });
      row = qtyRow + 1;
      const boxRow = row;
      put(`A${boxRow}`, '每箱件数', {});
      mergeSlotRow(boxRow);
      row = boxRow + 1;
      const cartonRow = row;
      put(`A${cartonRow}`, '箱数', {});
      mergeSlotRow(cartonRow);
      sizeKeys.forEach((s, i) => {
        const c = COL(slots[i].start);
        put(`${c}${cartonRow}`, '', { formula: `IF(${c}${boxRow}>0,${c}${qtyRow}/${c}${boxRow},"")` });
      });
      row = cartonRow + 1;
    }
    if (g.items.length === 0) row = 27; // 无明细:只留表头结构
    boxBorder(24, 1, row - 1, 11);
    for (let r = 24; r < row; r++) ws.getRow(r).height = 25;

    // ── 工厂要求(范本 30-37 行,标签沿用范本;空的留白手填)──
    const reqRows: [string, string][] = [
      ['成衣辅料：', bomJoin(['trim', 'lining', 'label'])],
      ['包装辅料：', bomJoin(['packing'])],
      ['裁剪要求：', ''],
      ['缝制要求：', joinTxt(mo.print_embroidery_requirements, mo.special_requirements)],
      ['检验要求：', mo.qc_focus || ''],
      ['包装要求', mo.factory_packing_instructions || ''],
      ['装箱要求', ''],
      ['注意事项', joinTxt(mo.risk_notes, mo.factory_notes)],
    ];
    for (const [label, text] of reqRows) {
      put(`A${row}`, label, {});
      ws.mergeCells(`B${row}:K${row}`);
      put(`B${row}`, text, { align: 'left', wrap: true });
      boxBorder(row, 1, row, 11);
      ws.getRow(row).height = text && text.length > 40 ? 50 : 25;
      row++;
    }

    // ── 抄送 + 签名(范本 38-39 行)──
    ws.mergeCells(`A${row}:K${row}`);
    put(`A${row}`, `抄送:采购、面料仓、辅料仓${order.factory_name ? '、' + order.factory_name : ''}、QC、包装组长、打包组长`, { align: 'left' });
    for (let c = 1; c <= 11; c++) ws.getCell(row, c).border = { top: { style: 'thin' } } as any;
    ws.getRow(row).height = 21;
    row++;
    put(`A${row}`, `制单：${nameOf(mo.created_by)}`, { align: 'left' });
    put(`C${row}`, '跟单：', { align: 'left' });
    put(`I${row}`, '批准：', { align: 'left' });
    ws.getRow(row).height = 25;
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
