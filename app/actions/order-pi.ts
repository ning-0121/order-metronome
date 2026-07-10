'use server';

/**
 * 订单 PI(形式发票 Proforma Invoice)· 生成 / 保存 / 导出(2026-07-09 用户)。
 * 版式严格对齐绮陌标准 PI 模板(PI for AAFB 119):14 列 + Jojo Fashion 抬头 + 买方/运输表头 + 合计行 + DEPOSIT。
 * 生成:从「生产单(逐款明细 order_line_items)」按款号归组,带款/色(逐色带量)/尺码/描述/箱数/数量,
 *      单价取客户 PO 成交价(po_unit_price)。业务补齐成分/克重/尺码配比/运输信息 → 存 order_pi(jsonb)。
 * 开票方抬头(Jojo Fashion Inc)是固定常量,不入库。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { buildPIWorkbook } from '@/lib/services/shipping-doc-builders';
import { hasRoleInGroup } from '@/lib/domain/roles';

const CAN_EDIT_PI = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

// 谁能看到 PI 上的客户成交价(po_unit_price):财务可见组 ∪ PI 编辑者(理单跟单要填 PI 故保留)。
// 排除生产/QC/物流/仓库/纯采购等无关角色——修 P0:此前 getPI/exportPI 无门禁,客户成交价泄露给所有登录角色(2026-07-09 审计)。
function canSeePIPrice(roles: string[]): boolean {
  return hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS') || roles.some((r) => CAN_EDIT_PI.includes(r));
}
// 无权角色下发降级版:抹掉逐款单价 + 定金,其余(款/色/码/箱数/数量/运输)照常。
function maskPIPrices<T extends { lines?: PILine[]; deposit?: string }>(d: T): T {
  return { ...d, deposit: '', lines: (d.lines || []).map((l) => ({ ...l, unit_price: 0 })) };
}

// 开票方固定抬头 · 义乌市绮陌服饰有限公司(2026-07-09 用户拍板,统一用此抬头)
const ISSUER = {
  company: 'YIWU QIMO CLOTHING CO.,LTD（义乌市绮陌服饰有限公司）',
  address: '2108 Room, Global Building, No.168 Financial 6th Street, Yiwu City, Zhejiang Province, China',
  contact: 'CONTACT: ALEX QIN    TEL: 86-15924281155    FAX: 0579-81548728    EMAIL: ALEX@QIMOCLOTHING.COM',
  title: 'PROFORMA INVOICE',
};

// 从「规格/面料名」抠出克重(如 280GSM)。规格文本形如 "85%P 15%S 280g 纱支…"。
function parseGsm(...texts: string[]): string {
  for (const t of texts) {
    const m = String(t || '').match(/(\d{2,4})\s*(?:gsm|g\/m2|g\b|克)/i);
    if (m) return `${m[1]}GSM`;
  }
  return '';
}

// 一行 = 一个款(多颜色并入 COLOR 单元格逐色带量)。列序严格对齐模板 A–N。
export interface PILine {
  po_no: string;          // A  PO NO.
  style_no: string;       // B  STYLE NO.
  style: string;          // C  STYLE(款名,可空)
  size: string;           // D  SIZE(如 "S-M-L-XL / 1-2-2-1")
  color: string;          // E  COLOR(多行:BLACK(1200SETS)…)
  description: string;    // F  DESCRIPTION
  composition: string;    // G  COMPOSITION(如 85%POLYESTER 15%SPANDEX)
  fabric_weight: string;  // H  FABRIC WEIGHT(如 280GSM)
  total_carton: number;   // I  TOTAL CARTON
  unit_per_carton: number;// J  UNIT PER CARTON
  qty: number;            // K  QTY(SETS/PCS)
  unit_price: number;     // L  UNIT PRICE(USD) LDP
  notes: string;          // N  NOTES(M=AMOUNT 由 qty×price 自动算)
}
export interface PIData {
  buyer_name: string; buyer_address: string; buyer_tel: string;
  invoice_no: string; issue_date: string; ship_via: string; destination: string;
  hbl: string; container: string; etd: string; eta: string;
  deposit: string; currency: string;
  lines: PILine[];
}

type PIBundle = PIData & { issuer: typeof ISSUER; has_saved: boolean; order_no: string | null; price_masked?: boolean };

function emptyLine(): PILine {
  return { po_no: '', style_no: '', style: '', size: '', color: '', description: '', composition: '', fabric_weight: '', total_carton: 0, unit_per_carton: 0, qty: 0, unit_price: 0, notes: '' };
}

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles };
}

function cleanData(data: Partial<PIData>): PIData {
  const s = (v: any) => String(v ?? '');
  const num = (v: any) => Number(v) || 0;
  return {
    buyer_name: s(data.buyer_name), buyer_address: s(data.buyer_address), buyer_tel: s(data.buyer_tel),
    invoice_no: s(data.invoice_no), issue_date: s(data.issue_date), ship_via: s(data.ship_via), destination: s(data.destination),
    hbl: s(data.hbl), container: s(data.container), etd: s(data.etd), eta: s(data.eta),
    deposit: s(data.deposit), currency: s(data.currency) || 'USD',
    lines: (data.lines || []).map((l) => ({
      po_no: s(l.po_no), style_no: s(l.style_no), style: s(l.style), size: s(l.size), color: s(l.color),
      description: s(l.description), composition: s(l.composition), fabric_weight: s(l.fabric_weight),
      total_carton: num(l.total_carton), unit_per_carton: num(l.unit_per_carton), qty: num(l.qty), unit_price: num(l.unit_price), notes: s(l.notes),
    })),
  };
}

/** 取 PI:有存过的返回存的;否则从生产单按款归组 + 客户PO价现算一份草稿。 */
export async function getPI(orderId: string): Promise<{ data?: PIBundle; error?: string }> {
  const { supabase, userId, roles } = await auth();
  if (!userId) return { error: '请先登录' };
  const seePrice = canSeePIPrice(roles);   // 无权看客户成交价 → 下方两个返回都抹价

  const { data: order, error: oErr } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, po_number, factory_date, currency, eta').eq('id', orderId).maybeSingle();
  if (oErr) return { error: `读取订单失败:${oErr.message}` };
  if (!order) return { error: '订单不存在' };

  const { data: saved } = await (supabase.from('order_pi') as any).select('data').eq('order_id', orderId).maybeSingle();
  const savedData = (saved as any)?.data as PIData | undefined;
  if (savedData && Array.isArray(savedData.lines) && savedData.lines.length) {
    const clean = cleanData(savedData);
    return { data: { ...(seePrice ? clean : maskPIPrices(clean)), issuer: ISSUER, has_saved: true, order_no: (order as any).order_no ?? null, price_masked: !seePrice } };
  }

  // 现算草稿:按款号归组(多颜色行并入一款)
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('style_no, product_name, product_name_en, color_cn, color_en, sizes, unit, qty_pcs, fabric_name, fabric_width, carton_count, po_unit_price, remark, line_no')
    .eq('order_id', orderId).order('line_no', { ascending: true });

  // 面料 BOM(克重/成分自动带过去):materials_bom 里 material_type=fabric/lining 行的 spec = 成分/克重/纱支
  const { data: bomFab } = await (supabase.from('materials_bom') as any)
    .select('style_no, material_name, spec, material_type')
    .eq('order_id', orderId).in('material_type', ['fabric', 'lining']);
  const fabByStyle = new Map<string, { spec: string; name: string }>();
  for (const b of (bomFab || []) as any[]) {
    const key = b.style_no || '';
    if (!fabByStyle.has(key)) fabByStyle.set(key, { spec: b.spec || '', name: b.material_name || '' });
  }

  const poNo = (order as any).po_number || (order as any).order_no || '';
  const qtyOf = (l: any) => Number(l.qty_pcs) || Object.values(l.sizes && typeof l.sizes === 'object' ? l.sizes : {}).reduce((s: number, v: any) => s + (Number(v) || 0), 0);

  const groups = new Map<string, any[]>();
  for (const l of (lis || []) as any[]) {
    const key = l.style_no || `__l${l.line_no}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l);
  }
  const lines: PILine[] = [...groups.values()].map((rows) => {
    const first = rows[0];
    const unitLabel = first.unit && !/pcs|件/i.test(first.unit) ? 'SETS' : 'PCS';
    const totalQty = rows.reduce((s, l) => s + qtyOf(l), 0);
    const totalCarton = rows.reduce((s, l) => s + (Number(l.carton_count) || 0), 0);
    // 按款×色合并(客户加单同款×色多行 → 合并求和,PI 不出 BLACK(500)\nBLACK(300))
    const _colorMap = new Map<string, { nm: string; qty: number; sizes: Record<string, number> }>();
    for (const l of rows) {
      const ck = `${(l.color_cn || '').trim()}|${(l.color_en || '').trim()}`;
      let m = _colorMap.get(ck);
      if (!m) { m = { nm: l.color_en || l.color_cn || '', qty: 0, sizes: {} }; _colorMap.set(ck, m); }
      m.qty += qtyOf(l);
      for (const [k, v] of Object.entries(l.sizes && typeof l.sizes === 'object' ? l.sizes : {})) m.sizes[k] = (Number(m.sizes[k]) || 0) + (Number(v) || 0);
    }
    const mergedColors = [..._colorMap.values()];
    const color = mergedColors.map((m) => m.qty ? `${m.nm}(${m.qty}${unitLabel})` : m.nm).filter(Boolean).join('\n');
    const sizeKeys = Object.keys(mergedColors.reduce((acc, m) => { for (const k of Object.keys(m.sizes)) acc[k] = 1; return acc; }, {} as Record<string, number>));
    const fab = fabByStyle.get(first.style_no || '') || fabByStyle.get('');
    return {
      po_no: poNo,
      style_no: first.style_no || '',
      style: first.product_name || '',
      size: sizeKeys.join('-'),
      color,
      description: first.product_name_en || first.product_name || '',
      composition: fab?.spec || '',                                         // 成分/规格自动带(materials_bom.spec)
      fabric_weight: parseGsm(fab?.spec || '', first.fabric_name || ''),    // 克重自动抠(280GSM)
      total_carton: totalCarton,
      unit_per_carton: totalCarton > 0 ? Math.round(totalQty / totalCarton) : 0,
      qty: totalQty,
      unit_price: Number(first.po_unit_price) || 0,
      notes: first.fabric_name || fab?.name || first.remark || '',
    };
  });

  const now = new Date();
  const issueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const draft: PIData = {
    buyer_name: (order as any).customer_name || '',
    buyer_address: '', buyer_tel: '',
    invoice_no: '', issue_date: issueDate, ship_via: '', destination: '',
    hbl: '', container: '', etd: '', eta: (order as any).eta || (order as any).factory_date || '',
    deposit: '', currency: (order as any).currency || 'USD',
    lines: lines.length ? lines : [emptyLine()],
  };
  return { data: { ...(seePrice ? draft : maskPIPrices(draft)), issuer: ISSUER, has_saved: false, order_no: (order as any).order_no ?? null, price_masked: !seePrice } };
}

/** 保存 PI(业务改完存)。 */
export async function savePI(orderId: string, data: PIData): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_EDIT_PI.includes(r))) return { error: '仅业务/理单/管理员可编辑 PI' };
  const clean = cleanData(data);
  const { error } = await (supabase.from('order_pi') as any).upsert({ order_id: orderId, data: clean, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: 'order_id' });
  if (error) {
    if (/order_pi|does not exist|schema cache/i.test(error.message || '')) return { error: 'PI 表尚未建立:请先在 Supabase 执行 20260709_order_pi.sql' };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 导出 PI Excel(严格贴模板版式:14 列 A–N)。base64 供前端下载。 */
export async function exportPI(orderId: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: '请先登录' };
  const res = await getPI(orderId);
  if ((res as any).error || !res.data) return { error: (res as any).error || 'PI 数据为空' };
  const pi = res.data;

  const wb = await buildPIWorkbook(pi);
  const buf = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buf as ArrayBuffer).toString('base64');
  const fileName = `PI-${res.data.order_no || orderId}-${pi.invoice_no || pi.lines[0]?.po_no || ''}.xlsx`.replace(/[^\w.\-]/g, '_');
  return { base64, fileName };
}
