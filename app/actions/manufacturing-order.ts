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
    .select('id, order_no, customer_name, product_name, style_no, quantity, etd, factory_date, packing_requirement, factory_name, owner_user_id')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('line_no, style_no, product_name, color_cn, color_en, sizes, unit, qty_pcs')
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
  const userIds = [order.owner_user_id, mo.confirmed_by, mo.released_to_factory_by].filter(Boolean);
  const nameMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', userIds);
    for (const p of (profs || [])) nameMap[(p as any).user_id] = (p as any).name;
  }
  const nameOf = (uid: any) => (uid && nameMap[uid]) ? nameMap[uid] : '—';
  const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : '');
  const fmtDateTime = (v: any) => {
    if (!v) return '';
    try { return new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); } catch { return String(v); }
  };
  const STATUS_CN: Record<string, string> = { draft: '草稿', reviewing: '复核中', confirmed: '已确认', executing: '已下发生产', closed: '完成' };

  // ── 配码表尺码列(标准序)──
  const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
  const sizeSet = new Set<string>();
  for (const li of lineItems) {
    if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
  }
  const sizeKeys = Array.from(sizeSet).sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  const TOTAL_COLS = Math.max(7, 2 + sizeKeys.length + 1);  // 至少 7 列(原辅料表用 7 列)

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('生产任务单');
  const thin: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  ws.columns = Array.from({ length: TOTAL_COLS }, (_, i) => ({ width: i === 0 ? 18 : i === 1 ? 20 : 12 }));
  const mergeAcross = (n: number) => ws.mergeCells(n, 1, n, TOTAL_COLS);

  const titleRow = ws.addRow([`生产任务单　${mo.mo_no || ''}`]);
  mergeAcross(titleRow.number);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  titleRow.getCell(1).alignment = { horizontal: 'center' };
  ws.addRow([]);

  const sectionTitle = (t: string) => {
    const r = ws.addRow([t]); mergeAcross(r.number);
    r.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF006400' } };
  };
  const headerRow = (cells: any[]) => {
    const r = ws.addRow(cells);
    r.eachCell((c: any) => { c.font = { bold: true }; c.border = thin; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; });
    return r;
  };
  // KV 行:label(col1) · value(col2-3 merge) · label2(col4) · value2(col5-end merge)
  const kv = (label: string, v: any, label2?: string, v2?: any) => {
    const r = ws.addRow([label, v ?? '', '', label2 || '', v2 ?? '']);
    r.getCell(1).font = { bold: true }; r.getCell(4).font = { bold: true };
    ws.mergeCells(r.number, 2, r.number, 3);
    if (TOTAL_COLS > 5) ws.mergeCells(r.number, 5, r.number, TOTAL_COLS);
  };

  // ── 一、订单基本信息 ──
  sectionTitle('一、订单基本信息');
  kv('订单号', order.order_no, '客户', order.customer_name);
  kv('款号', order.style_no, '产品名称', order.product_name);
  kv('数量', order.quantity, '生产工厂', order.factory_name || '—');
  kv('工厂交期', fmtDate(order.factory_date), 'ETD（出货交期）', fmtDate(order.etd));
  kv('业务员', nameOf(order.owner_user_id), '状态', STATUS_CN[mo.status] || mo.status);
  ws.addRow([]);

  // ── 二、款色码明细(配码表矩阵)──
  sectionTitle('二、款色码明细（配码表）');
  headerRow(['款号', '颜色', ...sizeKeys, '合计']);
  if (lineItems.length === 0) {
    const r = ws.addRow(['（无款色码明细，请在 PO 解析 / 订单明细录入）']); mergeAcross(r.number);
  } else {
    const colTotals: Record<string, number> = {}; let grand = 0;
    for (const li of lineItems) {
      const color = [li.color_cn, li.color_en].filter(Boolean).join(' / ');
      let rowTotal = 0;
      const sizeCells = sizeKeys.map(k => {
        const q = li.sizes && typeof li.sizes === 'object' ? Number(li.sizes[k]) : 0;
        const n = isNaN(q) ? 0 : q;
        if (n) { rowTotal += n; colTotals[k] = (colTotals[k] || 0) + n; }
        return n || '';
      });
      grand += rowTotal;
      const r = ws.addRow([li.style_no || order.style_no || '', color, ...sizeCells, rowTotal || '']);
      r.eachCell((c: any) => { c.border = thin; });
    }
    const totalRow = ws.addRow(['总计', '', ...sizeKeys.map(k => colTotals[k] || ''), grand]);
    totalRow.eachCell((c: any) => { c.border = thin; c.font = { bold: true }; });
    ws.mergeCells(totalRow.number, 1, totalRow.number, 2);
  }
  ws.addRow([]);

  // ── 三、原辅料摘要(+ 特殊要求)──
  sectionTitle('三、原辅料摘要');
  headerRow(['物料名称', '类型', '颜色', '位置', '单耗', '单位', '特殊要求']);
  for (const b of bom) {
    const r = ws.addRow([b.material_name, CAT_LABEL[b.material_type] || b.material_type, b.color || '', b.placement || '', b.qty_per_piece ?? '', b.unit || '', b.special_requirements || '']);
    r.eachCell((c: any) => { c.border = thin; });
    r.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  }
  if (bom.length === 0) { const r = ws.addRow(['（无原辅料明细，请在「原辅料和包装」录入）']); mergeAcross(r.number); }
  ws.addRow([]);

  // ── 四、生产执行说明(MO 6 字段)──
  sectionTitle('四、生产执行说明');
  const field = (label: string, v: any) => {
    const r = ws.addRow([label, v ?? '']);
    ws.mergeCells(r.number, 2, r.number, TOTAL_COLS);
    r.getCell(1).font = { bold: true };
    r.getCell(1).border = thin; r.getCell(2).border = thin;
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  };
  field('印绣要求', mo.print_embroidery_requirements);
  field('内部包装说明', mo.factory_packing_instructions);
  field('QC 重点', mo.qc_focus);
  field('特殊要求', mo.special_requirements);
  field('风险提醒', mo.risk_notes);
  field('其他下厂说明', mo.factory_notes);
  ws.addRow([]);

  // ── 五、确认信息 ──
  sectionTitle('五、确认信息');
  kv('MO 号', mo.mo_no || '', '当前状态', STATUS_CN[mo.status] || mo.status);
  kv('内容确认人', nameOf(mo.confirmed_by), '确认时间', fmtDateTime(mo.confirmed_at));
  kv('下发人', nameOf(mo.released_to_factory_by), '下发时间', fmtDateTime(mo.released_to_factory_at));
  kv('打印时间', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), '', '');
  ws.addRow([]);

  // ── 六、附件提示(静态,Evidence≠Data)──
  sectionTitle('六、附件提示');
  const note = ws.addRow(['客户原始 PO / Tech Pack / 图片等请在系统订单附件中查看；本表不复制附件内容。']);
  mergeAcross(note.number);
  note.getCell(1).alignment = { wrapText: true };
  note.getCell(1).font = { italic: true, color: { argb: 'FF888888' } };

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
