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
    .select('id, order_no, customer_name, product_name, style_no, quantity, etd, factory_date, packing_requirement')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('line_no, style_no, product_name, color_cn, color_en, sizes, unit, qty_pcs')
    .eq('order_id', orderId).order('line_no');

  const { data: bom } = await (supabase.from('materials_bom') as any)
    .select('material_name, material_type, material_code, color, placement, qty_per_piece, unit, supplier, material_master_id')
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

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('生产任务单');
  const thin: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  ws.columns = [{ width: 16 }, { width: 22 }, { width: 16 }, { width: 22 }, { width: 14 }, { width: 14 }];

  const titleRow = ws.addRow([`生产任务单　${mo.mo_no || ''}`]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, 6);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  titleRow.getCell(1).alignment = { horizontal: 'center' };
  ws.addRow([]);

  const kv = (label: string, v: any, label2?: string, v2?: any) => {
    const r = ws.addRow([label, v ?? '', label2 || '', v2 ?? '']);
    r.getCell(1).font = { bold: true }; r.getCell(3).font = { bold: true };
    return r;
  };
  // ── Customer Order 绑定(单一真相,不复制)──
  kv('客户', order.customer_name, '订单号', order.order_no);
  kv('款号', order.style_no, '产品', order.product_name);
  kv('数量', order.quantity, '工厂交期', order.factory_date ? String(order.factory_date).slice(0, 10) : '');
  kv('ETD', order.etd ? String(order.etd).slice(0, 10) : '', '状态', mo.status);
  ws.addRow([]);

  const sectionTitle = (t: string) => {
    const r = ws.addRow([t]); ws.mergeCells(r.number, 1, r.number, 6);
    r.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF006400' } };
  };
  const headerRow = (cells: string[]) => {
    const r = ws.addRow(cells);
    r.eachCell((c: any) => { c.font = { bold: true }; c.border = thin; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; });
    return r;
  };

  // ── 款×色×码(order_line_items)──
  sectionTitle('款 × 色 × 码');
  headerRow(['款号', '颜色', '尺码配比', '数量(件)', '单位', '']);
  for (const li of lineItems) {
    const sizes = li.sizes && typeof li.sizes === 'object'
      ? Object.entries(li.sizes).map(([k, v]) => `${k}:${v}`).join(' ') : '';
    const color = [li.color_cn, li.color_en].filter(Boolean).join(' / ');
    const r = ws.addRow([li.style_no || order.style_no || '', color, sizes, li.qty_pcs ?? '', li.unit || 'pcs', '']);
    r.eachCell((c: any) => { c.border = thin; });
  }
  if (lineItems.length === 0) { const r = ws.addRow(['(无款色码明细)']); ws.mergeCells(r.number, 1, r.number, 6); }
  ws.addRow([]);

  // ── 原辅料包(materials_bom 摘要)──
  sectionTitle('原辅料包(Material Package)');
  headerRow(['物料名称', '类别', '颜色', '部位', '单耗', '单位']);
  for (const b of bom) {
    const r = ws.addRow([b.material_name, CAT_LABEL[b.material_type] || b.material_type, b.color || '', b.placement || '', b.qty_per_piece ?? '', b.unit || '']);
    r.eachCell((c: any) => { c.border = thin; });
  }
  if (bom.length === 0) { const r = ws.addRow(['(无原辅料明细)']); ws.mergeCells(r.number, 1, r.number, 6); }
  ws.addRow([]);

  // ── 工厂执行说明(MO 的 6 个翻译字段)──
  sectionTitle('工厂执行说明');
  const field = (label: string, v: any) => {
    const r = ws.addRow([label, v ?? '']);
    ws.mergeCells(r.number, 2, r.number, 6);
    r.getCell(1).font = { bold: true };
    r.getCell(1).border = thin; r.getCell(2).border = thin;
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  };
  field('印绣要求', mo.print_embroidery_requirements);
  field('QC 重点', mo.qc_focus);
  field('特殊要求', mo.special_requirements);
  field('风险提醒', mo.risk_notes);
  field('包装说明', mo.factory_packing_instructions);
  field('其他下厂说明', mo.factory_notes);

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
