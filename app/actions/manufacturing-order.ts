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
import { requireRoleGroup } from '@/lib/domain/requireRole';

const MO_WRITE_MSG = '仅业务/跟单/生产/生产主管/管理员可编辑或推进生产任务单';

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
    .select('id, order_no, internal_order_no, po_number, customer_name, product_description, style_no, quantity, etd, factory_date, order_date, packaging_type, factory_name, owner_user_id, created_by, po_parse_snapshot')
    .eq('id', orderId).single();
  if (oErr) return { error: friendlyError(oErr) };
  // 尺码列手排顺序(容错读:列未建/迁移未执行时静默为 null,不 brick 生产任务单)
  const { data: soRow } = await (supabase.from('orders') as any).select('size_order').eq('id', orderId).maybeSingle();
  (order as any).size_order = Array.isArray((soRow as any)?.size_order) ? (soRow as any).size_order : null;

  const { data: mo } = await (supabase.from('manufacturing_orders') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  // select * :双语/箱数列(20260703 迁移)未执行时也不报缺列,拿到什么用什么
  const { data: lineItems } = await (supabase.from('order_line_items') as any)
    .select('*').eq('order_id', orderId).order('line_no');

  const { data: bom } = await (supabase.from('materials_bom') as any)
    .select('material_name, material_type, material_code, color, placement, qty_per_piece, unit, supplier, special_requirements, notes, image_urls, material_master_id, style_no, spec, customer_supplied, factory_supplied')
    .eq('order_id', orderId).order('material_type');

  // 多客户PO合单:来源PO容器(生产单按PO批次拆用)。表未建时静默返回空,不影响生产单生成。
  const { data: customerPos } = await (supabase.from('order_customer_pos') as any)
    .select('id, customer_po_number, seq').eq('order_id', orderId).order('seq');

  return { data: { mo: mo || null, order, lineItems: lineItems || [], bom: bom || [], customerPos: customerPos || [] } };
}

/** 录入/保存生产任务单的 6 个翻译字段(无则建,自动赋 mo_no=MO-{order_no})。 */
export async function upsertManufacturingOrder(orderId: string, fields: MoFields) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_MO', MO_WRITE_MSG); if (err) return { error: err }; }

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
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_MO', MO_WRITE_MSG); if (err) return { error: err }; }
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
 *
 * 两张单独出(2026-07-09 用户拍板:包装辅料常确认得晚,故拆开在两个环节生成):
 *   ① 生产订单(第一张,款式主表)—— generateProductionOrderSheet,建单即可出,不等 BOM。
 *   ② 辅料单(第二张,辅料明细)—— generateTrimSheet,在「原辅料和包装」页填完 BOM 后出,读最新 BOM。
 * generateManufacturingOrderSheet 仍保留合并版(两张一起),供生产中心/采购核料页整包下载。
 */
type MoBuildOpts = { styles: boolean; trims: boolean; label: string };

/** 合并版:生产订单 + 辅料明细 一份 Excel(生产中心/采购核料页整包用)。 */
export async function generateManufacturingOrderSheet(orderId: string) {
  return buildMoWorkbook(orderId, { styles: true, trims: true, label: '生产任务单' });
}
/** 第一张:只出「生产订单」(款式主表)——建单即可生成,不等 BOM/辅料确认。 */
export async function generateProductionOrderSheet(orderId: string) {
  return buildMoWorkbook(orderId, { styles: true, trims: false, label: '生产订单' });
}
/** 第二张:只出「辅料单」(辅料明细)——在「原辅料和包装」页填完 BOM 后生成,自动读最新 BOM。 */
export async function generateTrimSheet(orderId: string) {
  return buildMoWorkbook(orderId, { styles: false, trims: true, label: '辅料单' });
}

async function buildMoWorkbook(
  orderId: string,
  opts: MoBuildOpts,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };

  const res = await getManufacturingOrder(orderId);
  if ((res as any).error) return { error: (res as any).error };
  const { mo: moRaw, order, lineItems, bom, customerPos } = (res as any).data;
  // 放宽:无 MO 记录也能生成(建单即可出「生产订单」);翻译/确认字段缺省则留白手填。
  const mo = moRaw || {};

  // 多客户PO合单:同一内部订单由多张客户PO合成时,生产单按PO批次拆(用户 2026-07-11 口径①)。
  //   同款同色来自两张PO → 明细两行不合并求和,车间按PO分批投产。
  //   单PO/老单(customerPos ≤ 1)→ multiPO=false,按款×色合并(不受影响,向后兼容)。
  const poList: any[] = Array.isArray(customerPos) ? customerPos : [];
  const multiPO = poList.length >= 2;
  const poById = new Map<string, { seq: number; num: string }>();
  for (const p of poList) poById.set(p.id, { seq: p.seq, num: p.customer_po_number });
  const poBatchLabel = (li: any): string => {
    if (!multiPO) return '';
    const p = li?.source_order_po_id ? poById.get(li.source_order_po_id) : null;
    return p ? `PO${p.seq}` : '';
  };

  // ── 名字解析(owner/confirmed/released → profiles.name)+ 格式化 ──
  const userIds = [order.owner_user_id, order.created_by, mo.confirmed_by, mo.released_to_factory_by, mo.created_by].filter(Boolean);
  const nameMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', userIds);
    for (const p of (profs || [])) nameMap[(p as any).user_id] = (p as any).name;
  }
  const nameOf = (uid: any) => (uid && nameMap[uid]) ? nameMap[uid] : '';
  const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : '');

  // ══ 生产任务单模板(1:1 复刻绮陌标准生产单;固定 A–J 十列,竖版 A4 单页)══
  // 全表宋体(公司名 22 加粗,正文 14);每款一个 sheet(结构完全一致,只换数据)+ 一张辅料明细。
  // 版式来源:用户提供的《1022955订单生产任务单》。尺码默认 S/M/L,可自适应 1–7 个尺码。
  const { orderSizeKeys } = await import('@/lib/utils/size-sort');
  const sizeOrderPref = (order as any).size_order as string[] | null;   // 业务手排的尺码顺序(优先)

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
  const thin = { style: 'thin' as const };
  const B4: any = { top: thin, left: thin, bottom: thin, right: thin };
  const COL = (n: number) => (n <= 26 ? String.fromCharCode(64 + n) : `A${String.fromCharCode(64 + n - 26)}`);
  const cnDate = (v: any) => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}月${d.getDate()}日` : ''; };
  const madeDateCN = cnDate(new Date().toISOString());
  const shipDateCN = cnDate(order.factory_date || order.etd);
  // 模板固定列宽 A–J
  const COLW = [22.05, 10.62, 9, 9, 12.25, 10.62, 11.62, 8.88, 9, 9];

  // 从图片二进制头解析原始像素尺寸(JPEG/PNG/GIF),用于按比例贴图不拉伸。解析失败返回 null。
  const imageDims = (buf: Buffer): { w: number; h: number } | null => {
    try {
      // PNG:签名 8B + IHDR,宽@16 高@20(大端)
      if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
      }
      // GIF:宽@6 高@8(小端)
      if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
        return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
      }
      // JPEG:扫描 SOF 段(0xFFC0–0xFFCF,除 C4/C8/CC),高@+3 宽@+5
      if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) { i++; continue; }
          let marker = buf[i + 1];
          while (marker === 0xff && i + 1 < buf.length) { i++; marker = buf[i + 1]; }
          i += 2;
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: buf.readUInt16BE(i + 3), w: buf.readUInt16BE(i + 5) };
          }
          if (i + 1 >= buf.length) break;
          i += buf.readUInt16BE(i);
        }
      }
    } catch { /* 解析失败按未知尺寸处理 */ }
    return null;
  };

  // 产品图/辅料图:公开桶 URL,服务端抓取失败不阻塞生成
  const fetchImage = async (url: string): Promise<{ buffer: Buffer; extension: 'jpeg' | 'png' | 'gif'; w: number | null; h: number | null } | null> => {
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
      const d = imageDims(buffer);
      return { buffer, extension: extension as any, w: d?.w ?? null, h: d?.h ?? null };
    } catch { return null; }
  };

  if (opts.styles) for (const [gi, g] of styleGroups.entries()) {
    const sheetName = (g.style_no || `款${gi + 1}`).replace(/[\\/*?:[\]]/g, '_').slice(0, 28) || `款${gi + 1}`;
    const ws = wb.addWorksheet(wb.worksheets.some(w => w.name === sheetName) ? `${sheetName}_${gi + 1}` : sheetName);
    ws.pageSetup = {
      paperSize: 9, orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true,
      margins: { left: 0.354, right: 0.354, top: 0.236, bottom: 0.118, header: 0, footer: 0 },
    };
    COLW.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    // 单元格 + 合并 + 边框(mode: full 全框 / bottom 仅底 / top 仅顶 / none 无)
    const box = (r1: number, c1: number, r2: number, c2: number, value: any, o: {
      size?: number; bold?: boolean; color?: string; align?: 'left' | 'center' | 'right'; wrap?: boolean; fill?: string; border?: 'full' | 'bottom' | 'top' | 'none';
    } = {}) => {
      const cell = ws.getCell(r1, c1);
      cell.value = (value === undefined || value === null) ? '' : value;
      cell.font = { name: '宋体', size: o.size ?? 14, bold: o.bold ?? false, color: o.color ? { argb: o.color } : undefined };
      // 自动优化(2026-07-09 用户:导出内容被截断)——单格且未强制换行 → shrinkToFit 让 Excel
      // 自动缩字号铺满、绝不截断(如「1.75*2」「13.875」在窄列);合并格 Excel 不支持 shrinkToFit
      // → 退回换行(wrapText)。长文本(品名/面料描述)可显式 wrap:true 走多行换行。
      const merged = r2 > r1 || c2 > c1;
      const shrink = !merged && o.wrap !== true;
      cell.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: shrink ? false : (o.wrap ?? true), shrinkToFit: shrink };
      if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
      if (merged) ws.mergeCells(r1, c1, r2, c2);
      const mode = o.border ?? 'full';
      if (mode !== 'none') for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        ws.getCell(r, c).border = mode === 'full' ? { ...B4 } : mode === 'bottom' ? { bottom: thin } : { top: thin };
      }
    };

    // 尺码集(默认 S/M/L,最多 7 个)
    const sizeSet = new Set<string>();
    for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) if (Number(li.sizes[k]) > 0) sizeSet.add(k);
    let sizeKeys = orderSizeKeys([...sizeSet], sizeOrderPref);
    if (sizeKeys.length === 0) sizeKeys = ['S', 'M', 'L'];
    sizeKeys = sizeKeys.slice(0, 7);
    const ns = sizeKeys.length;
    const cTol = 2 + ns;      // 公差列
    const cImg1 = 3 + ns;     // 产品图起列(与 J=10 之间为图区)
    // 订单数量:B..J 共 9 列按尺码数均分成组(ns=3 → B:D / E:G / H:J,与模板一致)
    const groups: [number, number][] = (() => {
      const start = 2, total = 9, base = Math.floor(total / ns), extra = total - base * ns; const gs: [number, number][] = [];
      let c = start;
      for (let i = 0; i < ns; i++) { const w = base + (i < extra ? 1 : 0); gs.push([c, c + w - 1]); c += w; }
      return gs;
    })();

    const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (styleGroups.length === 1 ? order.quantity : 0);

    // 面料(最多 2 种:主面料 + 第二面料;BOM fabric 行,无 style_no 视为整单通用)。
    // 去重:同一面料若既有款专属行又有整单通用行(或重复录入)会被当成"两种面料"填两次
    //   (用户反馈:只有一种面料却填了两次)。按 料号/(料名+规格) 归并,款专属行优先(用料更准)。
    // 按显示身份(料名+规格)归并 —— 用户眼里"同名同规格"就是同一种面料,料号可能一有一无反而漏并
    const fabKey = (b: any) => `${String(b?.material_name || '').trim().toLowerCase()}|${String(b?.spec || '').trim().toLowerCase()}`;
    const seenFab = new Set<string>();
    const styleFabrics = bom
      .filter((b: any) => b.material_type === 'fabric' && (!b.style_no || String(b.style_no).trim() === String(g.style_no).trim()))
      .sort((a: any, b: any) => (a.style_no ? 0 : 1) - (b.style_no ? 0 : 1))   // 款专属行排前,去重时优先保留
      .filter((b: any) => { const k = fabKey(b); if (seenFab.has(k)) return false; seenFab.add(k); return true; });
    const fbDesc = (f: any) => [f?.material_name, f?.spec].filter(Boolean).join(' ');
    const fbUse = (f: any) => (f && f.qty_per_piece != null) ? `${f.qty_per_piece} ${f.unit || 'kg'}/件` : '';
    const f0 = styleFabrics[0];
    // 主面料=第一种;第二种起全部列进「第二面料」格(原来只取 f1,3 种以上被丢 → 2026-07-11 改为全列出)
    const moreFabs = styleFabrics.slice(1);
    const moreDesc = moreFabs.map(fbDesc).filter(Boolean).join('；');
    const moreUse = moreFabs.map((f: any) => `${f?.material_name || ''} ${fbUse(f)}`.trim()).filter(Boolean).join('；');

    // 尺码明细表(PO 冻结底档 measurements;固定 9 行,不足留白,多则截断 → 右侧产品图块高度统一)
    const snapStyles: any[] = Array.isArray((order as any).po_parse_snapshot?.styles) ? (order as any).po_parse_snapshot.styles : [];
    const snapStyle = snapStyles.find((s: any) => String(s?.style_no || '').trim() === String(g.style_no || '').trim());
    const measAll: any[] = Array.isArray(snapStyle?.measurements) ? snapStyle.measurements : [];
    const measVal = (values: Record<string, any> | undefined, key: string) => {
      if (!values) return '';
      if (values[key] != null) return String(values[key]);
      const hit = Object.keys(values).find(k => k.trim().toLowerCase() === key.trim().toLowerCase());
      return hit ? String(values[hit]) : '';
    };

    // 固定区行高
    ws.getRow(1).height = 27; ws.getRow(2).height = 21.95; ws.getRow(3).height = 21.75;
    for (let rr = 4; rr <= 19; rr++) ws.getRow(rr).height = 25;

    // R1 公司名 / R2 标题(无边框)
    box(1, 1, 1, 10, '义乌市绮陌服饰有限公司', { size: 22, bold: true, border: 'none' });
    box(2, 1, 2, 10, '生产任务单', { size: 14, border: 'none' });

    // R3 订单号 / 总数量 / 制单 / 发货(仅底线,同模板)
    box(3, 1, 3, 1, '订单号：', { align: 'right', border: 'bottom' });
    box(3, 2, 3, 2, order.internal_order_no || order.order_no || '', { align: 'left', border: 'bottom' });
    box(3, 3, 3, 3, '总数量:', { align: 'right', border: 'bottom' });
    box(3, 4, 3, 4, styleTotal || '', { align: 'left', border: 'bottom' });
    box(3, 5, 3, 5, '制单日期：', { align: 'center', border: 'bottom' });
    box(3, 6, 3, 6, madeDateCN, { align: 'left', border: 'bottom' });
    box(3, 7, 3, 7, '发货日期：', { align: 'center', border: 'bottom' });
    box(3, 8, 3, 10, shipDateCN, { align: 'center', border: 'bottom' });

    // R4 款号 / 品名
    box(4, 1, 4, 1, '款    号'); box(4, 2, 4, 4, g.style_no || '', { bold: true });
    box(4, 5, 4, 5, '品    名'); box(4, 6, 4, 10, [g.product_name, (g.items[0] as any)?.product_name_en].filter(Boolean).join(' '), { bold: true });
    // R5 主面料 / 第二面料(含第 3 种起的其余面料,全列出不丢)
    box(5, 1, 5, 1, '主 面 料'); box(5, 2, 5, 4, fbDesc(f0)); box(5, 5, 5, 5, moreFabs.length ? '第二面料' : ''); box(5, 6, 5, 10, moreDesc);
    // R6 主面料用料 / 第二面料用料
    box(6, 1, 6, 1, '主面料用料'); box(6, 2, 6, 4, fbUse(f0)); box(6, 5, 6, 5, moreFabs.length ? '第二面料用料' : ''); box(6, 6, 6, 10, moreUse);

    // R7 分类 / 尺码明细表 / 产品图片(标签)
    box(7, 1, 7, 1, '分    类'); box(7, 2, 7, cTol, '尺码明细表单位：英寸'); box(7, cImg1, 7, 10, '产品图片');
    // R8 尺码表头
    box(8, 1, 8, 1, '尺    码');
    sizeKeys.forEach((s, i) => box(8, 2 + i, 8, 2 + i, s));
    box(8, cTol, 8, cTol, '公差');
    // R9–R17 测量行(固定 9 行)
    for (let j = 0; j < 9; j++) {
      const rr = 9 + j; const m = measAll[j] || {};
      box(rr, 1, rr, 1, m.label || '');
      const vals = sizeKeys.map(s => measVal(m.values, s));
      const nonEmpty = vals.filter(v => v !== '').length;
      if (ns > 1 && nonEmpty === 1 && vals[0] !== '') {
        // 单一值跨所有尺码列(如「档宽*长 1.75*2」),同模板 B16:D16 合并
        box(rr, 2, rr, cTol - 1, vals[0]);
      } else {
        sizeKeys.forEach((s, i) => box(rr, 2 + i, rr, 2 + i, vals[i]));
      }
      box(rr, cTol, rr, cTol, m.tolerance || '');
    }
    // 产品图块 F8:J17(标签在 R7,图铺满 8–17)
    box(8, cImg1, 17, 10, '', { border: 'full' });
    const pimg = await fetchImage(g.image_url);
    if (pimg) {
      const id = wb.addImage({ buffer: pimg.buffer as any, extension: pimg.extension });
      ws.addImage(id, { tl: { col: cImg1 - 1, row: 7 } as any, br: { col: 10, row: 17 } as any });
    }

    // ── 订单数量表 ──
    box(18, 1, 19, 1, '颜色');            // A18:A19
    box(18, 2, 18, 10, '订单数量');        // B18:J18
    groups.forEach(([c1, c2], i) => box(19, c1, 19, c2, sizeKeys[i]));   // R19 尺码分组表头
    let r = 20;
    // 按款×色合并(客户加单会产生同款×色多行 → 工厂只看每 SKU 总数,合并求和 sizes/箱数/件数)。
    // 多PO合单(multiPO)时改按 色×来源PO 合并 → 同款同色来自两张PO保持两行,车间按PO分批投产(口径①)。
    const _mergedColors = new Map<string, any>();
    for (const li of g.items) {
      const batch = poBatchLabel(li);   // 多PO时 = PO1/PO2…;单PO/老单 = ''
      const key = `${(li.color_cn || '').trim()}|${(li.color_en || '').trim()}|${multiPO ? (li.source_order_po_id || '') : ''}`;
      let m = _mergedColors.get(key);
      if (!m) { m = { color_cn: li.color_cn, color_en: li.color_en, po_batch: batch, sizes: {} as Record<string, number>, qty_pcs: 0, carton_count: 0 }; _mergedColors.set(key, m); }
      for (const [k, v] of Object.entries(li.sizes || {})) m.sizes[k] = (Number(m.sizes[k]) || 0) + (Number(v) || 0);
      m.qty_pcs += Number(li.qty_pcs) || 0;
      m.carton_count += Number(li.carton_count) || 0;
    }
    const colorItems = _mergedColors.size ? [..._mergedColors.values()] : [{}];
    const colorRowNo: number[] = [];
    for (const li of colorItems) {
      ws.getRow(r).height = 25;
      box(r, 1, r, 1, [li.po_batch, li.color_en, li.color_cn].filter(Boolean).join(' ') || '');
      groups.forEach(([c1, c2], i) => box(r, c1, r, c2, (li.sizes && Number(li.sizes[sizeKeys[i]])) || ''));
      colorRowNo.push(r); r++;
    }
    // 每箱件数
    const cartonPer = (() => { const c = colorItems.find((li: any) => Number(li.carton_count) > 0 && Number(li.qty_pcs) > 0); return c ? Math.round(Number(c.qty_pcs) / Number(c.carton_count)) : null; })();
    const cartonRow = r; ws.getRow(r).height = 25;
    box(r, 1, r, 1, '每箱件数'); box(r, 2, r, 10, cartonPer ?? ''); r++;
    // 各色箱数(公式 =(各码合计)/每箱件数,同模板)
    colorItems.forEach((li: any, i: number) => {
      ws.getRow(r).height = 25;
      const name = [li.po_batch, li.color_en, li.color_cn].filter(Boolean).join(' ') || '颜色';
      box(r, 1, r, 1, `${name}箱数`);
      if (cartonPer) box(r, 2, r, 10, { formula: `(${groups.map(([c1]) => COL(c1) + colorRowNo[i]).join('+')})/B${cartonRow}` } as any);
      else box(r, 2, r, 10, '');
      r++;
    });

    // ── 各类要求(8 行;MO 字段带出,无则留白手填)──
    const trimsForReq = bom.filter((b: any) => !b.style_no || String(b.style_no).trim() === String(g.style_no).trim());
    const nmList = (arr: any[]) => arr.map((b: any) => b.material_name).filter(Boolean).join('，');
    const garment = nmList(trimsForReq.filter((b: any) => ['trim', 'lining', 'embroidery'].includes(b.material_type)));
    const packing = nmList(trimsForReq.filter((b: any) => ['packing', 'label', 'washing', 'print'].includes(b.material_type)));
    const estH = (t: any) => { const s = String(t || ''); if (!s) return 25; const per = 30; const lines = s.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / per)), 0); return lines <= 1 ? 25 : Math.min(160, 25 + (lines - 1) * 19); };
    // 模板固定行高:缝制要求/包装要求 两行较高(73/69),其余 25;内容更长则按内容加高(不小于模板)
    const reqBaseH = [25, 25, 25, 73, 25, 69, 25, 25];
    const reqRows: [string, any, boolean?][] = [
      ['成衣辅料：', garment || '无'],
      ['包装辅料：', packing],
      ['裁剪要求：', mo.factory_notes || ''],
      ['缝制要求：', mo.print_embroidery_requirements || ''],
      ['检验要求：', mo.qc_focus || ''],
      ['包装要求：', mo.factory_packing_instructions || ''],
      ['装箱要求：', ''],
      ['注意事项：', mo.risk_notes || mo.special_requirements || '', true],
    ];
    reqRows.forEach(([label, val, red], i) => {
      box(r, 1, r, 1, label);
      box(r, 2, r, 10, val, { align: 'left', bold: !!red, color: red ? 'FFFF0000' : undefined });
      ws.getRow(r).height = Math.max(reqBaseH[i], estH(val)); r++;
    });

    // ── 抄送 + 签名(无外框,仅抄送顶线)──
    box(r, 1, r, 10, `抄送:采购、面料仓、辅料仓、QC、包装组长、打包组长${order.factory_name ? '、' + order.factory_name : ''}`, { align: 'left', border: 'top' });
    ws.getRow(r).height = 21; r++;
    box(r, 1, r, 1, `制单：${nameOf(order.created_by) || nameOf(mo.created_by)}`, { align: 'left', border: 'none' });
    box(r, 2, r, 2, `跟单：${nameOf(order.owner_user_id)}`, { align: 'left', border: 'none' });
    box(r, 7, r, 7, '批准：', { align: 'left', border: 'none' });
    ws.getRow(r).height = 24.75;

    ws.pageSetup.printArea = `A1:J${r}`;
  }

  // ══ 辅料明细(每个款号一张 sheet,1:1 复刻用户「辅料表」模板)══
  // 列:物料 | 示例画稿(图) | 位置说明及示意图(图) | 位置说明(文) | 规格 | 备注(文) | 工厂价格 | 采购价格
  // ① 顶部订单号用内部单号(internal_order_no),厂里能对上;② 贴图按原始比例居中不拉伸;
  // ③ 规格单独成列(不再埋进备注);④ 按 materials_bom.style_no 分款,一款一 sheet。
  // 图从 materials_bom.image_urls 带出:[0]→示例画稿, [1]→位置示意图(业务在「原辅料」页 📷 上传)。
  // 工厂价格/采购价格留空手填(不泄底价);辅料 = 所有非 fabric 的 BOM 行。
  if (opts.trims) {
    const internalNo = order.internal_order_no || order.order_no || '';
    // 按款号分组;无款号的行(整单共用辅料)归入「通用」组。保持录入顺序。
    const COMMON = '__common__';
    const trimGroups: { key: string; label: string; rows: any[] }[] = [];
    for (const b of bom.filter((x: any) => x.material_type !== 'fabric')) {
      const raw = b.style_no != null ? String(b.style_no).trim() : '';
      const key = raw || COMMON;
      let g = trimGroups.find(x => x.key === key);
      if (!g) { g = { key, label: raw || '通用', rows: [] }; trimGroups.push(g); }
      g.rows.push(b);
    }
    if (trimGroups.length === 0) trimGroups.push({ key: COMMON, label: order.style_no ? String(order.style_no) : '通用', rows: [] });

    const usedSheetNames = new Set(wb.worksheets.map(w => w.name));
    const trimSheetName = (label: string): string => {
      const base = `${label}辅料`.replace(/[\\/*?:[\]]/g, '_').slice(0, 28) || '辅料';
      let name = base, i = 2;
      while (usedSheetNames.has(name)) name = `${base}_${i++}`.slice(0, 31);
      usedSheetNames.add(name);
      return name;
    };

    for (const g of trimGroups) {
      const ts = wb.addWorksheet(trimSheetName(g.label));
      ts.pageSetup = {
        paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
        margins: { left: 0.35, right: 0.35, top: 0.3, bottom: 0.2, header: 0, footer: 0 },
      };
      const cw = [19.6, 38.5, 35.1, 30, 15, 22, 13.7, 16.2];   // 物料/示例画稿/位置图/位置说明/规格/备注/工厂价/采购价
      cw.forEach((w, i) => (ts.getColumn(i + 1).width = w));
      const NCOL = cw.length;   // 8 列
      // 单元格像素尺寸(用于贴图按比例居中):列宽字符→px≈round(w*7)+5;行高 pt→px=pt*4/3。
      const colPx = (c: number) => Math.round((cw[c - 1] || 9) * 7) + 5;
      const tbox = (r: number, c: number, v: any, o: { size?: number; bold?: boolean; align?: 'left' | 'center' } = {}) => {
        const cell = ts.getCell(r, c); cell.value = (v === undefined || v === null) ? '' : v;
        cell.font = { name: '宋体', size: o.size ?? 16, bold: o.bold ?? false };
        cell.alignment = { horizontal: o.align ?? 'center', vertical: 'middle', wrapText: true };
        cell.border = { ...B4 };
      };
      const titleStyle = g.key === COMMON ? '' : `（${g.label}）`;
      ts.mergeCells(1, 1, 1, NCOL); tbox(1, 1, `${internalNo}订单辅料明细${titleStyle}`, { size: 16, bold: true });
      ts.getRow(1).height = 33;
      const th = ['', '示例画稿（以实际为准）', '位置说明及示意图', '位置说明', '规格', '备注', '工厂价格', '采购价格'];
      th.forEach((h, i) => tbox(2, i + 1, h, { size: 14, bold: true }));
      ts.getRow(2).height = 40;

      // 预取每行辅料图,位置固定:image_urls[0]→示例画稿, image_urls[1]→位置说明及示意图。
      // 按位置取(不再 filter 压缩):表单两个图槽各写各的下标,只填示意图也不会错落到示例画稿列。并行,抓取失败不阻塞。
      const trimImgs = await Promise.all(g.rows.map(async (b: any) => {
        const urls = (Array.isArray(b.image_urls) ? b.image_urls : []);
        const pick = (u: any) => (typeof u === 'string' && /^https?:\/\//.test(u)) ? u : '';
        const [a, c] = await Promise.all([fetchImage(pick(urls[0])), fetchImage(pick(urls[1]))]);
        return { a, c };
      }));

      const ROW_H = 150;   // 贴图行高(pt)
      let tr = 3;
      g.rows.forEach((b: any, idx: number) => {
        // 备注:特殊要求 + 备注 + 颜色(规格已独立成列,不再并入)
        const remark = joinTxt(b.special_requirements, b.notes, b.color ? `颜色：${b.color}` : '');
        // 供料方式:加工厂承担/客供 标在物料名后,给生产照做 + 财务监督(加工厂承担=费用工厂出,绮陌不采购)
        const supplyTag = b.factory_supplied === true ? '【加工厂承担】' : (b.customer_supplied === true ? '【客供】' : '');
        tbox(tr, 1, `${b.material_name || ''}${supplyTag}`);    // 物料(带供料方式标注)
        tbox(tr, 2, '');                                        // 示例画稿(下方贴图)
        tbox(tr, 3, '');                                        // 位置说明及示意图(下方贴图)
        tbox(tr, 4, b.placement || '', { align: 'left' });      // 位置说明(文字)
        tbox(tr, 5, b.spec || '');                              // 规格(独立列)
        tbox(tr, 6, remark, { align: 'left' });                 // 备注
        tbox(tr, 7, '');                                        // 工厂价格(采购填,不带底价)
        tbox(tr, 8, '');                                        // 采购价格(采购填)
        const { a, c } = trimImgs[idx];
        ts.getRow(tr).height = (a || c) ? ROW_H : 44;
        // 贴图:oneCell 锚点 + 原始比例缩放居中(不用 twoCell 铺满,避免拉伸变形)。
        const place = (im: { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif'; w: number | null; h: number | null } | null, col0: number) => {
          if (!im) return;
          const id = wb.addImage({ buffer: im.buffer as any, extension: im.extension });
          const cellW = colPx(col0 + 1), cellH = Math.round(ROW_H * 4 / 3);
          const maxW = cellW * 0.9, maxH = cellH * 0.9;
          const nw = im.w && im.w > 0 ? im.w : maxW, nh = im.h && im.h > 0 ? im.h : maxH;
          const scale = Math.min(maxW / nw, maxH / nh);
          const drawW = Math.max(1, Math.round(nw * scale)), drawH = Math.max(1, Math.round(nh * scale));
          const offC = (cellW - drawW) / 2 / cellW, offR = (cellH - drawH) / 2 / cellH;
          ts.addImage(id, { tl: { col: col0 + offC, row: (tr - 1) + offR } as any, ext: { width: drawW, height: drawH } } as any);
        };
        place(a, 1);   // B 列(0-indexed 1)= 示例画稿
        place(c, 2);   // C 列(0-indexed 2)= 位置示意图
        tr++;
      });
      if (g.rows.length === 0) { for (let c = 1; c <= NCOL; c++) tbox(3, c, ''); ts.getRow(3).height = 44; }
      ts.pageSetup.printArea = `A1:${COL(NCOL)}${Math.max(3, tr - 1)}`;
    }
  }

  if (wb.worksheets.length === 0) return { error: '没有可生成的内容' };
  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const orderTag = order.order_no || (mo as any).mo_no || orderId.slice(0, 8);
  return { ok: true, base64, fileName: `${opts.label}_${orderTag}.xlsx` };
}
