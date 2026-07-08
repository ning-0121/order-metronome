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
    .select('id, order_no, internal_order_no, po_number, customer_name, product_description, style_no, quantity, etd, factory_date, order_date, packaging_type, factory_name, owner_user_id, po_parse_snapshot')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  // select * :双语/箱数列(20260703 迁移)未执行时也不报缺列,拿到什么用什么
  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('*').eq('order_id', orderId).order('line_no');

  const { data: bom } = await (supabase.from('materials_bom') as any)
    .select('material_name, material_type, material_code, color, placement, qty_per_piece, unit, supplier, special_requirements, notes, image_urls, material_master_id, style_no, spec')
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

  // 工厂内部单号(制单日期用当天;发货日期用工厂交期/ETD)
  const madeDate = fmtDate(new Date().toISOString());
  const shipDate = fmtDate(order.factory_date || order.etd);

  for (const [gi, g] of styleGroups.entries()) {
    const sheetName = (g.style_no || `款${gi + 1}`).replace(/[\\/*?:[\]]/g, '_').slice(0, 28) || `款${gi + 1}`;
    const ws = wb.addWorksheet(wb.worksheets.some(w => w.name === sheetName) ? `${sheetName}_${gi + 1}` : sheetName);
    ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    // 该款尺码集(至少 3 列)
    const sizeSet = new Set<string>();
    for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) if (Number(li.sizes[k]) > 0) sizeSet.add(k);
    const sizeKeys = sortSizes([...sizeSet]).slice(0, 8);
    const ns = Math.max(sizeKeys.length, 3);
    const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (styleGroups.length === 1 ? order.quantity : 0);

    // 该款面料(BOM fabric 行;无 style_no 视为整单通用)
    const fabrics = bom.filter((b: any) => b.material_type === 'fabric' && (!b.style_no || String(b.style_no).trim() === String(g.style_no).trim()));
    const fabricNames = fabrics.map((b: any) => b.material_name).filter(Boolean).join('  /  ')
      || g.items.find((li: any) => li.fabric_name)?.fabric_name || '';
    const fabricUsage = fabrics.map((b: any) => b.qty_per_piece != null ? `${b.material_name}：${b.qty_per_piece} ${b.unit || 'kg'}/件` : '').filter(Boolean).join('  /  ');

    // 尺寸明细表数据(从 PO 冻结底档 measurements 拉;公差列无结构化数据 → 留白手填)
    const snapStyles: any[] = Array.isArray((order as any).po_parse_snapshot?.styles) ? (order as any).po_parse_snapshot.styles : [];
    const snapStyle = snapStyles.find((s: any) => String(s?.style_no || '').trim() === String(g.style_no || '').trim());
    const meas: Array<{ label?: string; values?: Record<string, any>; tolerance?: string }> =
      Array.isArray(snapStyle?.measurements) ? snapStyle.measurements.slice(0, 14) : [];
    const measVal = (values: Record<string, any> | undefined, key: string) => {
      if (!values) return '';
      if (values[key] != null) return String(values[key]);
      const hit = Object.keys(values).find(k => k.trim().toLowerCase() === key.trim().toLowerCase());
      return hit ? String(values[hit]) : '';
    };

    // 列:标签(1) | 尺码(2..1+ns) | 公差(2+ns) | 产品图(3+ns..NC 3列)
    const cLabel = 1, cSize0 = 2, cTol = 2 + ns, cImg1 = 3 + ns, NC = 3 + ns + 2;
    ws.getColumn(cLabel).width = 16;
    for (let c = cSize0; c < cSize0 + ns; c++) ws.getColumn(c).width = 11;
    ws.getColumn(cTol).width = 11;
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
    // 一行:标签 + 合并值(整行边框)
    const kv = (r: number, label: string, value: any, opt: { fill?: string; font?: any; c2?: number; align?: 'left' | 'center' } = {}) => {
      const c2 = opt.c2 ?? NC;
      put(r, 1, label, SONG({ bold: true }), { align: 'left' });
      mergeR(r, 2, c2); put(r, 2, value ?? '', opt.font || TIMES({ bold: true }), { align: opt.align || 'left', fill: opt.fill, wrap: true });
      boxBorder(r, 1, r, c2); ws.getRow(r).height = 30;
    };

    let r = 1;
    // R1 公司名 / R2 标题
    mergeR(r, 1, NC); put(r, 1, '义乌市绮陌服饰有限公司', SONG({ bold: true, size: 20 })); boxBorder(r, 1, r, NC); ws.getRow(r).height = 30; r++;
    mergeR(r, 1, NC); put(r, 1, '生产任务单', SONG({ bold: true, size: 26 })); boxBorder(r, 1, r, NC); ws.getRow(r).height = 36; r++;
    // R3 订单号/总数量/制单日期/发货日期(黄底 发货日期)
    kv(r, '订单号：', [order.internal_order_no, order.order_no, order.po_number ? `PO ${order.po_number}` : null].filter(Boolean).join('  |  ')
      + `        总数量：${styleTotal || ''}        制单日期：${madeDate}        发货日期：${shipDate}（不得延期）`, { fill: YELLOW }); r++;
    // R4 款号/品名
    kv(r, '款  号：', `${g.style_no || ''}        品  名：${[g.product_name, (g.items[0] as any)?.product_name_en].filter(Boolean).join(' ')}`); r++;
    // R5/R6 主面料 + 用料
    kv(r, '主 面 料：', fabricNames); r++;
    kv(r, '主面料用料：', fabricUsage); r++;

    // ── 尺寸明细表(R7 标题行 + R8 表头 + 测量行);右侧产品图合并块 ──
    const measStart = r;
    put(r, 1, '分  类', SONG({ bold: true })); mergeR(r, 2, cTol); put(r, 2, '尺码明细表  单位：英寸', SONG({ bold: true }));
    // 注:产品图列(cImg1..NC)不在此行单独合并 —— 由下方 measStart..measEnd 整块合并覆盖(避免重叠 merge 抛错)
    boxBorder(r, 1, r, cTol); ws.getRow(r).height = 28; r++;
    // 尺码表头
    put(r, 1, '尺  码', SONG({ bold: true }), { fill: SIZE_NORMAL_BG });
    sizeKeys.forEach((s, i) => put(r, cSize0 + i, s, TIMES({ bold: true }), { fill: isPlusSize(s) ? SIZE_PLUS_BG : SIZE_NORMAL_BG }));
    for (let i = sizeKeys.length; i < ns; i++) put(r, cSize0 + i, '', TIMES({ bold: true }), { fill: SIZE_NORMAL_BG });
    put(r, cTol, '公差', SONG({ bold: true }), { fill: SIZE_NORMAL_BG });
    boxBorder(r, 1, r, cTol); ws.getRow(r).height = 26; r++;
    // 测量行(有底档用底档;否则留一批空行手填)
    const measRows = meas.length > 0 ? meas : Array.from({ length: 8 }, () => ({ label: '', values: {}, tolerance: '' }));
    for (const m of measRows) {
      put(r, 1, m.label || '', SONG(), { align: 'left' });
      sizeKeys.forEach((s, i) => put(r, cSize0 + i, measVal(m.values, s), TIMES()));
      put(r, cTol, (m as any).tolerance || '', TIMES());
      boxBorder(r, 1, r, cTol); ws.getRow(r).height = 24; r++;
    }
    const measEnd = r - 1;
    // 产品图:合并块贴在测量表右侧
    ws.mergeCells(measStart, cImg1, measEnd, NC); boxBorder(measStart, cImg1, measEnd, NC);
    const img = await fetchImage(g.image_url);
    if (img) {
      const imgId = wb.addImage({ buffer: img.buffer as any, extension: img.extension });
      ws.addImage(imgId, `${COL(cImg1)}${measStart}:${COL(NC)}${measEnd}`);
    } else {
      put(measStart, cImg1, '产品图片', SONG({ color: { argb: 'FF999999' } }));
    }

    // ── 颜色 × 尺码 订单数量 ──
    put(r, 1, '颜  色', SONG({ bold: true }), { fill: YELLOW }); mergeR(r, 2, cTol); put(r, 2, '订单数量', SONG({ bold: true }), { fill: YELLOW });
    boxBorder(r, 1, r, cTol); ws.getRow(r).height = 26; r++;
    put(r, 1, '', SONG());
    sizeKeys.forEach((s, i) => put(r, cSize0 + i, s, TIMES({ bold: true }), { fill: SIZE_NORMAL_BG }));
    put(r, cTol, '小计', SONG({ bold: true }), { fill: SIZE_NORMAL_BG });
    boxBorder(r, 1, r, cTol); ws.getRow(r).height = 24; r++;
    const cartonPer = (() => {
      const c = g.items.find((li: any) => Number(li.carton_count) > 0 && Number(li.qty_pcs) > 0);
      return c ? Math.round(Number(c.qty_pcs) / Number(c.carton_count)) : null;
    })();
    for (const li of g.items) {
      put(r, 1, [li.color_en, li.color_cn].filter(Boolean).join(' ') || '—', SONG(), { align: 'left' });
      sizeKeys.forEach((s, i) => put(r, cSize0 + i, (li.sizes && Number(li.sizes[s])) || '', TIMES()));
      put(r, cTol, Number(li.qty_pcs) || '', ARIAL());
      boxBorder(r, 1, r, cTol); ws.getRow(r).height = 24; r++;
    }
    // 每箱件数 + 各色箱数
    kv(r, '每箱件数：', cartonPer ?? '', { c2: cTol }); r++;
    for (const li of g.items) {
      const cartons = (li as any).carton_count ?? (cartonPer && Number(li.qty_pcs) ? Math.ceil(Number(li.qty_pcs) / cartonPer) : '');
      kv(r, `${[li.color_en, li.color_cn].filter(Boolean).join(' ') || '颜色'}箱数：`, cartons, { c2: cTol }); r++;
    }

    // ── 各类要求(8 行;有 MO 字段带出,无则留白手填)──
    const reqRows: [string, string][] = [
      ['成衣辅料：', ''],
      ['包装辅料：', bom.filter((b: any) => ['label', 'packing', 'trim'].includes(b.material_type)).map((b: any) => b.material_name).filter(Boolean).join('，')],
      ['裁剪要求：', mo.factory_notes || ''],
      ['缝制要求：', mo.print_embroidery_requirements || ''],
      ['检验要求：', mo.qc_focus || ''],
      ['包装要求：', mo.factory_packing_instructions || ''],
      ['装箱要求：', ''],
      ['注意事项：', mo.risk_notes || mo.special_requirements || ''],
    ];
    for (const [label, val] of reqRows) { kv(r, label, val); ws.getRow(r).height = Math.max(30, 26 * (String(val).split('\n').length)); r++; }

    // 抄送 + 签名
    mergeR(r, 1, NC); put(r, 1, `抄送：采购、面料仓、辅料仓${order.factory_name ? '、' + order.factory_name : ''}、QC、包装`, SONG({ bold: true }), { align: 'left' });
    boxBorder(r, 1, r, NC); ws.getRow(r).height = 28; r++;
    const third = Math.max(2, Math.floor(NC / 3));
    put(r, 1, `制单：${nameOf(mo.created_by)}`, SONG({ bold: true }), { align: 'left' });
    put(r, third, `跟单：${nameOf(order.owner_user_id)}`, SONG({ bold: true }), { align: 'left' });
    put(r, third * 2, '批准：', SONG({ bold: true }), { align: 'left' });
    boxBorder(r, 1, r, NC); ws.getRow(r).height = 30;
  }

  // ══ 辅料明细 sheet(全款合一,1:1 复刻用户「辅料表」模板)══
  // 列:物料 | 示例画稿(图) | 位置说明及示意图(图) | 位置说明(文) | 备注(文) | 工厂价格 | 采购价格
  // 图从 materials_bom.image_urls 带出:[0]→示例画稿, [1]→位置示意图(业务在「原辅料」页 📷 上传的辅料/色卡图)。
  // 工厂价格/采购价格留空手填(不泄底价);辅料 = 所有非 fabric 的 BOM 行。
  {
    const ts = wb.addWorksheet('辅料明细');
    ts.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1 };
    const cols = [20, 38, 35, 35, 22, 14, 16];   // 对齐模板列宽
    cols.forEach((w, i) => (ts.getColumn(i + 1).width = w));
    const tput = (r: number, c: number, v: any, font: any, opt: { fill?: string; align?: 'left' | 'center' } = {}) => {
      const cell = ts.getCell(r, c); cell.value = v; cell.font = font;
      cell.alignment = { horizontal: opt.align || 'center', vertical: 'middle', wrapText: true };
      if (opt.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } };
      cell.border = thin;
    };
    ts.mergeCells(1, 1, 1, 7); tput(1, 1, `${order.order_no || ''} 订单辅料明细`, SONG({ bold: true, size: 18 }));
    ts.getRow(1).height = 32;
    const th = ['物料', '示例画稿（以实际为准）', '位置说明及示意图', '位置说明', '备注', '工厂价格', '采购价格'];
    th.forEach((h, i) => tput(2, i + 1, h, SONG({ bold: true }), { fill: YELLOW }));
    ts.getRow(2).height = 30;

    const trims = bom.filter((b: any) => b.material_type !== 'fabric');
    // 预取每行辅料图(image_urls[0]→示例画稿, image_urls[1]→示意图);并行,抓取失败不阻塞生成。
    const trimImgs = await Promise.all(trims.map(async (b: any) => {
      const urls = (Array.isArray(b.image_urls) ? b.image_urls : []).filter((u: any) => typeof u === 'string' && u);
      const [a, c] = await Promise.all([fetchImage(urls[0] || ''), fetchImage(urls[1] || '')]);
      return { a, c };
    }));

    let tr = 3;
    trims.forEach((b: any, idx: number) => {
      // 备注:特殊要求 + 备注 + 规格 + 颜色(有则拼,便于工厂/采购一眼看全)
      const remark = joinTxt(
        b.special_requirements, b.notes,
        b.spec ? `规格：${b.spec}` : '', b.color ? `颜色：${b.color}` : '',
      );
      tput(tr, 1, b.material_name || '', SONG({ bold: true }), { align: 'left' });
      tput(tr, 2, '', SONG());                                   // 示例画稿(下方贴图)
      tput(tr, 3, '', SONG());                                   // 位置说明及示意图(下方贴图)
      tput(tr, 4, b.placement || '', SONG(), { align: 'left' }); // 位置说明(文字)
      tput(tr, 5, remark, SONG(), { align: 'left' });            // 备注
      tput(tr, 6, '', SONG());                                   // 工厂价格(采购填,不带底价)
      tput(tr, 7, '', SONG());                                   // 采购价格(采购填)
      // 贴图(oneCell 锚点,固定尺寸,随单元格移动不缩放)。有图则加高行,无图给文字留高。
      const { a, c } = trimImgs[idx];
      ts.getRow(tr).height = (a || c) ? 80 : 44;
      const place = (im: { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | null, col0: number) => {
        if (!im) return;
        const id = wb.addImage({ buffer: im.buffer as any, extension: im.extension });
        ts.addImage(id, { tl: { col: col0 + 0.1, row: (tr - 1) + 0.1 } as any, ext: { width: 130, height: 95 }, editAs: 'oneCell' });
      };
      place(a, 1);   // B 列(0-indexed 1)= 示例画稿
      place(c, 2);   // C 列(0-indexed 2)= 位置示意图
      tr++;
    });
    if (trims.length === 0) { for (let c = 1; c <= 7; c++) tput(3, c, '', SONG()); ts.getRow(3).height = 44; }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { ok: true, base64, fileName: `生产任务单_${order.order_no || mo.mo_no}.xlsx` };
}
