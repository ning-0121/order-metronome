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
    .select('id, order_no, internal_order_no, po_number, customer_name, product_description, style_no, quantity, etd, factory_date, order_date, packaging_type, factory_name, owner_user_id')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  // select * :双语/箱数列(20260703 迁移)未执行时也不报缺列,拿到什么用什么
  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('*').eq('order_id', orderId).order('line_no');

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

  // V2 钩子:生产任务单「下发工厂执行」(executing) → 自动完成里程碑 mo_released(生产任务单下发)。
  // 侧效应:仅 V2 订单有此节点;V1/在途订单命中 0 行静默返回。任何异常吞掉,绝不阻塞主链路。
  if (status === 'executing') {
    try { await autoCompleteMoReleased(supabase, orderId, user.id); } catch { /* 侧效应,忽略 */ }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * V2:MO 下发工厂执行时自动完成里程碑 mo_released。
 * 仅对 V2 订单存在此节点;V1/在途订单没有该行 → 命中 0 行,静默返回(安全)。
 * 仅在节点尚未完成时推进,不覆盖已完成数据;写审计日志 + fire-and-forget 触发交付置信度重算。
 */
async function autoCompleteMoReleased(supabase: any, orderId: string, userId: string): Promise<void> {
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('id, status')
    .eq('order_id', orderId)
    .eq('step_key', 'mo_released')
    .maybeSingle();
  if (!ms) return;                                  // 非 V2 订单 / 无此节点
  const st = String(ms.status || '').toLowerCase();
  if (st === 'done' || st === '已完成') return;      // 已完成不重复

  const now = new Date().toISOString();
  const { error: upErr } = await (supabase.from('milestones') as any)
    .update({ status: 'done', completed_at: now, actual_at: now, updated_at: now })
    .eq('id', ms.id);
  if (upErr) return;

  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: ms.id,
    order_id: orderId,
    action: 'status_transition',
    note: '生产任务单下发工厂执行 → 系统自动完成「生产任务单下发」节点',
    payload: { auto: true, source: 'manufacturing_order.executing', by: userId },
  });

  // fire-and-forget:触发交付置信度重算(内部已 catch 所有错)
  void (async () => {
    try {
      const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
      await recomputeDeliveryConfidence(orderId, {
        type: 'milestone_status_changed',
        source: `milestone:${ms.id}`,
        severity: 'info',
        payload: { milestone_id: ms.id, new_status: 'done', old_status: ms.status, auto: 'mo_released' },
      });
    } catch { /* 忽略 */ }
  })();
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

  // ══ 生产任务单模板 V3(2026-07-03,按用户提供的「辉念」工厂任务单版式)══
  // 每款一个 sheet:头部(订单号/品名/交期黄底/数量 + 右侧面料成分·克重)
  // → 明细表(款号|大身颜色双语|款式描述|箱数|PO红字|数量|普通码/加大码分色尺码列|备注红字|图片)
  // → 总计 → 整行黄色分隔 → 交样时间(产前样/船样+要求+右侧注意) → 款式评语 → 包装附页 → 签收人
  // → (追加)用料单耗(BOM 自动带出,辉念无此节,我们保留喂核料)
  // 每款另配一张「{款号}尺寸表」sheet(留白按上传尺码表填)。
  // 字体对齐模板:中文标签宋体20B/英文值 Times New Roman 20/数据 Arial 20。
  const { sortSizeKeys: sortSizes } = await import('@/lib/utils/size-sort');

  // 交样时间:产前样/船样 用节点排期(有则填,无则留白手填)
  const sampleDue: Record<string, string> = {};
  try {
    const { data: msRows } = await (supabase.from('milestones') as any)
      .select('step_key, due_at').eq('order_id', orderId)
      .in('step_key', ['pre_production_sample_approved', 'shipping_sample_send']);
    for (const m of (msRows || [])) {
      const d = m.due_at ? new Date(m.due_at) : null;
      if (d && !isNaN(d.getTime())) sampleDue[m.step_key] = `${d.getMonth() + 1}.${d.getDate()}`;
    }
  } catch { /* 拿不到就留白 */ }

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
  // 模板字体族(辉念版式):中文标签宋体/英文值 Times/数据 Arial,主体 20pt
  const SONG = (o: any = {}) => ({ name: '宋体', size: 20, ...o });
  const TIMES = (o: any = {}) => ({ name: 'Times New Roman', size: 20, ...o });
  const ARIAL = (o: any = {}) => ({ name: 'Arial', size: 20, ...o });
  const YELLOW = 'FFFFFF00';           // 模板同款纯黄(交期/表头/分隔行)
  const SIZE_NORMAL_BG = 'FFDDEBF7';   // 普通码列(浅蓝)
  const SIZE_PLUS_BG = 'FFFCE4D6';     // 加大码列(浅橙)
  const REMARK_BG = 'FFE2EFDA';        // 备注列头(浅绿)
  const RED = 'FFFF0000';
  const BLUE = 'FF0000FF';
  const isPlusSize = (s: string) => /^\d+X$/i.test(String(s).trim()) || /^0X$/i.test(String(s).trim());
  const thin: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const COL = (n: number) => (n <= 26 ? String.fromCharCode(64 + n) : `A${String.fromCharCode(64 + n - 26)}`);

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
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    // 该款尺码集(至少留 3 个空位手填)
    const sizeSet = new Set<string>();
    for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
    const sizeKeys = sortSizes([...sizeSet]).slice(0, 8);
    const ns = Math.max(sizeKeys.length, 3);
    const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (styleGroups.length === 1 ? order.quantity : 0);
    const fabricLi = g.items.find((li: any) => li.fabric_name) || {};
    const fabricName = (fabricLi as any).fabric_name || bom.find((b: any) => b.material_type === 'fabric' && (!b.style_no || b.style_no === g.style_no))?.material_name || '';
    const fabricSpec = (fabricLi as any).fabric_width || '';

    // 列布局(辉念):款号|大身颜色|款式描述|箱数|PO|数量|尺码×ns|备注|图片×3
    const cStyle = 1, cColor = 2, cDesc = 3, cCarton = 4, cPO = 5, cQty = 6;
    const cSize0 = 7;                        // 尺码起始列
    const cRemark = cSize0 + ns;             // 备注
    const cImg1 = cRemark + 1, NC = cImg1 + 2;  // 图片 3 列
    ws.getColumn(cStyle).width = 20; ws.getColumn(cColor).width = 34; ws.getColumn(cDesc).width = 34;
    ws.getColumn(cCarton).width = 9; ws.getColumn(cPO).width = 10; ws.getColumn(cQty).width = 11;
    for (let c = cSize0; c < cSize0 + ns; c++) ws.getColumn(c).width = 9;
    ws.getColumn(cRemark).width = 26;
    for (let c = cImg1; c <= NC; c++) ws.getColumn(c).width = 13;

    const put = (r: number, c: number, v: any, font: any, opt: { align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; formula?: string } = {}) => {
      const cell = ws.getCell(r, c);
      cell.value = opt.formula ? ({ formula: opt.formula } as any) : v;
      cell.font = font;
      cell.alignment = { horizontal: opt.align || 'center', vertical: 'middle', wrapText: opt.wrap !== false };
      if (opt.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } };
    };
    const boxBorder = (r1: number, c1: number, r2: number, c2: number) => {
      for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) ws.getCell(rr, cc).border = thin;
    };
    const mergeR = (r: number, c1: number, c2: number) => { if (c2 > c1) ws.mergeCells(r, c1, r, c2); };

    // ── 头部块 R1-R4:左 标签+值,右 面料成分/克重(模板同款)──
    // R1 订单号 | R2 品名 | R3 交期(黄底) | R4 数量
    const rightC1 = cRemark + 1;                 // 右块起始列(与图片列对齐)
    const headVal = (r: number, label: string, value: any, opt: { fill?: string; font?: any } = {}) => {
      mergeR(r, 1, 3); put(r, 1, label, SONG({ bold: true }));
      mergeR(r, 4, cRemark); put(r, 4, value ?? '', opt.font || TIMES({ bold: true }), { fill: opt.fill });
      boxBorder(r, 1, r, cRemark);
      ws.getRow(r).height = 32;
    };
    headVal(1, '订单号', [
      order.internal_order_no,                              // 内部单号(订单册编号,财务口径)在最前
      order.order_no,
      order.po_number ? `PO ${order.po_number}` : null,
    ].filter(Boolean).join(' | '));
    headVal(2, '品名', [g.product_name, (g.items[0] as any)?.product_name_en].filter(Boolean).join('  '));
    headVal(3, '交期', `${fmtDate(order.factory_date || order.etd)}（客户装柜日，不得延期）`, { fill: YELLOW });
    headVal(4, '数量', styleTotal || '');
    // 右块:面料成分(R1-R2) + 克重/门幅(R3-R4)
    ws.mergeCells(1, rightC1, 2, NC); put(1, rightC1, fabricName, TIMES({ bold: true }), { wrap: true });
    ws.mergeCells(3, rightC1, 4, NC); put(3, rightC1, fabricSpec, TIMES({ bold: true }));
    boxBorder(1, rightC1, 4, NC);

    // ── 明细表头 R5(黄底;尺码列按普通码/加大码分色;备注浅绿)──
    const hd = 5;
    put(hd, cStyle, '款号', SONG({ bold: true }), { fill: YELLOW });
    put(hd, cColor, '大身颜色', SONG({ bold: true }), { fill: YELLOW });
    put(hd, cDesc, '款式描述', SONG({ bold: true }), { fill: YELLOW });
    put(hd, cCarton, '箱数', SONG({ bold: true }), { fill: YELLOW });
    put(hd, cPO, 'PO', TIMES({ bold: true, color: { argb: RED } }), { fill: YELLOW });
    put(hd, cQty, '数量', SONG({ bold: true }), { fill: YELLOW });
    sizeKeys.forEach((s, i) => put(hd, cSize0 + i, s, TIMES({ bold: true }), { fill: isPlusSize(s) ? SIZE_PLUS_BG : SIZE_NORMAL_BG }));
    for (let i = sizeKeys.length; i < ns; i++) put(hd, cSize0 + i, '', TIMES({ bold: true }), { fill: SIZE_NORMAL_BG });
    put(hd, cRemark, '备注', SONG({ bold: true }), { fill: REMARK_BG });
    mergeR(hd, cImg1, NC); put(hd, cImg1, '图片', SONG({ bold: true }));
    ws.getRow(hd).height = 32;

    // ── 数据行(每色一行)──
    let row = hd + 1;
    const firstColorRow = row;
    for (const li of g.items) {
      put(row, cStyle, li.style_no || g.style_no || '', ARIAL());
      put(row, cColor, [li.color_en, li.color_cn].filter(Boolean).join(' ') || '—', ARIAL(), { wrap: true });
      put(row, cDesc, [li.product_name || g.product_name, (li as any).product_name_en].filter(Boolean).join('\n'), SONG(), { wrap: true });
      put(row, cCarton, (li as any).carton_count ?? '', SONG());
      put(row, cPO, order.po_number || '', SONG({ color: { argb: RED } }));
      put(row, cQty, Number(li.qty_pcs) || '', ARIAL());
      sizeKeys.forEach((s, i) => {
        const q = li.sizes && typeof li.sizes === 'object' ? Number(li.sizes[s]) || 0 : 0;
        put(row, cSize0 + i, q || '', TIMES(), { fill: isPlusSize(s) ? SIZE_PLUS_BG : SIZE_NORMAL_BG });
      });
      put(row, cRemark, li.remark || '', SONG({ color: { argb: RED } }), { wrap: true });
      ws.getRow(row).height = 32;
      row++;
    }
    if (g.items.length === 0) { ws.getRow(row).height = 32; row++; }
    const lastColorRow = row - 1;

    // ── 总计行(数量红字)──
    mergeR(row, cStyle, cColor); put(row, cStyle, '总计', SONG());
    put(row, cCarton, '', SONG(), lastColorRow >= firstColorRow ? { formula: `SUM(${COL(cCarton)}${firstColorRow}:${COL(cCarton)}${lastColorRow})` } : {});
    put(row, cQty, '', TIMES({ color: { argb: RED } }), lastColorRow >= firstColorRow ? { formula: `SUM(${COL(cQty)}${firstColorRow}:${COL(cQty)}${lastColorRow})` } : {});
    ws.getRow(row).height = 32;
    boxBorder(hd, 1, row, cRemark);
    const totalRow = row;
    // 图片区:表头下贴合并块(模板 O5 合并样式)
    ws.mergeCells(firstColorRow, cImg1, totalRow, NC);
    boxBorder(firstColorRow, cImg1, totalRow, NC);
    const img = await fetchImage(g.image_url);
    if (img) {
      const imgId = wb.addImage({ buffer: img.buffer as any, extension: img.extension });
      ws.addImage(imgId, `${COL(cImg1)}${firstColorRow}:${COL(NC)}${totalRow}`);
    } else {
      put(firstColorRow, cImg1, '产品图片', SONG({ color: { argb: 'FF999999' } }));
    }
    row++;

    // ── 整行黄色分隔(模板 R10 同款)──
    for (let c = 1; c <= NC; c++) put(row, c, '', SONG(), { fill: YELLOW });
    ws.getRow(row).height = 14;
    row++;

    // ── 交样时间块:表头 + 产前样/船样(日期蓝字,要求红字,右侧注意)──
    const noteC1 = cRemark + 1;
    const sampleHd = row;
    put(row, 1, '', SONG({ bold: true }));
    mergeR(row, 2, 4); put(row, 2, '交样时间', SONG({ bold: true }));
    mergeR(row, cQty, cRemark); put(row, cQty, '要求', SONG({ bold: true }));
    ws.getRow(row).height = 30;
    row++;
    const sampleRows: [string, string, string][] = [
      ['产前样', sampleDue['pre_production_sample_approved'] || '', mo.special_requirements || ''],
      ['船样', sampleDue['shipping_sample_send'] || '', ''],
    ];
    for (const [label, date, req] of sampleRows) {
      put(row, 1, label, SONG({ bold: true }));
      mergeR(row, 2, 4); put(row, 2, date, TIMES({ bold: true, color: { argb: BLUE } }));
      mergeR(row, cQty, cRemark); put(row, cQty, req, SONG({ bold: true, color: { argb: RED } }), { align: 'left', wrap: true });
      ws.getRow(row).height = 34;
      row++;
    }
    boxBorder(sampleHd, 1, row - 1, cRemark);
    // 右侧「注意」竖块(模板 Q11 合并)
    ws.mergeCells(sampleHd, noteC1, row - 1, NC);
    put(sampleHd, noteC1, mo.qc_focus ? `注意：${mo.qc_focus}` : '', SONG({ bold: true }), { wrap: true });
    boxBorder(sampleHd, noteC1, row - 1, NC);

    // ── 款式评语(合并标题行 + 内容大行)──
    mergeR(row, 1, NC); put(row, 1, '款式评语', SONG({ bold: true }));
    boxBorder(row, 1, row, NC); ws.getRow(row).height = 30;
    row++;
    const comments = ['1.' + (mo.print_embroidery_requirements || ''), mo.risk_notes ? '2.' + mo.risk_notes : '', mo.factory_notes ? '3.' + mo.factory_notes : '']
      .filter(t => t && t !== '1.').join('\n');
    mergeR(row, 1, NC); put(row, 1, comments ? `\n${comments}` : '', TIMES({ bold: true }), { align: 'left', wrap: true });
    boxBorder(row, 1, row, NC); ws.getRow(row).height = Math.max(60, 26 * (comments.split('\n').length + 1));
    row++;

    // ── 包装明细行 + 签收人 ──
    mergeR(row, 1, NC);
    put(row, 1, mo.factory_packing_instructions ? `包装明细及要求：${mo.factory_packing_instructions}` : '包装明细及要求详见附页', SONG({ bold: true }), { align: 'left', wrap: true });
    boxBorder(row, 1, row, NC); ws.getRow(row).height = 34;
    row++;
    mergeR(row, 1, 2); put(row, 1, '签收人：', SONG({ bold: true }), { align: 'left' });
    boxBorder(row, 1, row, NC); ws.getRow(row).height = 34;
    row += 2;

    // ── (追加)用料单耗:辉念模板无此节,保留喂核料/工厂领料(样式对齐)──
    const bomSorted = [...bom]
      .filter((b: any) => !b.style_no || b.style_no === g.style_no)
      .sort((a: any, b: any) => (a.material_type === 'fabric' ? 0 : 1) - (b.material_type === 'fabric' ? 0 : 1));
    if (bomSorted.length > 0) {
      mergeR(row, 1, NC); put(row, 1, '用料单耗', SONG({ bold: true }), { fill: YELLOW });
      boxBorder(row, 1, row, NC); ws.getRow(row).height = 30;
      row++;
      const bh = row;
      put(bh, 1, '物料', SONG({ bold: true })); put(bh, 2, '颜色', SONG({ bold: true }));
      put(bh, 3, '规格', SONG({ bold: true })); put(bh, 4, '单耗/件', SONG({ bold: true }));
      put(bh, 5, '单位', SONG({ bold: true }));
      mergeR(bh, 6, NC); put(bh, 6, '备注', SONG({ bold: true }));
      ws.getRow(bh).height = 28;
      row++;
      for (const b of bomSorted) {
        put(row, 1, b.material_name || '', SONG(), { align: 'left', wrap: true });
        put(row, 2, b.color || '', SONG());
        put(row, 3, (b as any).spec || '', SONG());
        put(row, 4, b.qty_per_piece ?? '', ARIAL());
        put(row, 5, b.unit || '', SONG());
        mergeR(row, 6, NC); put(row, 6, joinTxt(b.placement, b.special_requirements), SONG(), { align: 'left', wrap: true });
        ws.getRow(row).height = 28;
        row++;
      }
      boxBorder(bh, 1, row - 1, NC);
      row++;
    }

    // ── 制单信息(小字)──
    mergeR(row, 1, NC);
    put(row, 1, `制单：${nameOf(mo.created_by)} ${fmtDate(new Date().toISOString())} · 抄送:采购、面料仓、辅料仓${order.factory_name ? '、' + order.factory_name : ''}、QC、包装组长`, SONG({ size: 12 }), { align: 'left' });

    // ── 该款尺寸表 sheet(模板同款:单独一张,留白按上传尺码表填)──
    const sizeSheetName = `${sheetName}尺寸表`.slice(0, 30);
    if (!wb.worksheets.some(w => w.name === sizeSheetName)) {
      const ss = wb.addWorksheet(sizeSheetName);
      ss.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1 };
      ss.getColumn(1).width = 38;
      for (let c = 2; c <= 1 + ns; c++) ss.getColumn(c).width = 12;
      const sput = (r: number, c: number, v: any, font: any, fill?: string) => {
        const cell = ss.getCell(r, c);
        cell.value = v; cell.font = font;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      };
      ss.mergeCells(1, 1, 1, 1 + ns);
      sput(1, 1, `${g.style_no || ''}尺寸工艺平量要求（inch)`, { name: '微软雅黑', size: 20, bold: true });
      ss.getRow(1).height = 34;
      // 普通码/加大码分组行(单列不合并,避免 exceljs 单格 merge 抛错)
      const normalCount = sizeKeys.filter(s => !isPlusSize(s)).length;
      const plusCount = sizeKeys.length - normalCount;
      if (normalCount > 0 && plusCount > 0) {
        if (normalCount > 1) ss.mergeCells(2, 2, 2, 1 + normalCount);
        sput(2, 2, 'MISSY', { name: 'Arial', size: 12, bold: true }, SIZE_NORMAL_BG);
        if (plusCount > 1) ss.mergeCells(2, 2 + normalCount, 2, 1 + sizeKeys.length);
        sput(2, 2 + normalCount, 'PLUS', { name: 'Arial', size: 12, bold: true }, SIZE_PLUS_BG);
      }
      sput(3, 1, 'POM (inch)', { name: 'Arial', size: 12 });
      sizeKeys.forEach((s, i) => sput(3, 2 + i, s, { name: 'Arial', size: 12, bold: true }));
      for (let i = 0; i < 14; i++) ss.getRow(4 + i).height = 24;
      for (let rr = 3; rr <= 17; rr++) for (let cc = 1; cc <= 1 + ns; cc++) ss.getCell(rr, cc).border = thin;
      ss.mergeCells(18, 1, 18, 1 + ns);
      sput(18, 1, '（按建单上传的尺码表填写;上传件见订单「附件」）', { name: '宋体', size: 11 });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
