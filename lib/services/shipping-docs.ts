/**
 * 出货单据统一数据模型 —— PL / CI / 预览 共用同一份,保证 Excel 和预览永不偏差。
 * 数据源:orders + packing_lists(doc_meta)+ packing_list_lines(出货事实)+ order_line_items(主数据/价)。
 */
import { EXPORT_SELLER } from '@/lib/domain/document-templates';

const CURRENCY = { USD: { code: 'USD', symbol: '$', label: 'USD' }, CNY: { code: 'CNY', symbol: '¥', label: 'RMB' } } as const;

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

// 服装标准码序:小 → 大。未识别的码按原始顺序排在末尾,保持稳定。
const SIZE_ORDER = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', 'XXXXL', '4XL', '5XL'];
function sizeRank(k: string): number {
  const u = String(k).trim().toUpperCase();
  const i = SIZE_ORDER.indexOf(u);
  if (i >= 0) return i;
  const n = Number(u);            // 纯数字码(如 34/36/38)按数值排
  if (Number.isFinite(n)) return 1000 + n;
  return 2000;                     // 未识别:排末尾,靠 stable sort 保原始序
}

/** 各码数量 → 约分比例文本,如 {S:300,M:600,L:600,XL:300} → "S-M-L-XL / 1-2-2-1"(模板 Size 列样式)。 */
export function sizeRatioText(sizes: any): string {
  if (!sizes || typeof sizes !== 'object') return '';
  const keys = Object.keys(sizes).filter(k => Number(sizes[k]) > 0)
    .sort((a, b) => sizeRank(a) - sizeRank(b));
  if (keys.length === 0) return '';
  const vals = keys.map(k => Number(sizes[k]));
  const g = vals.reduce((a, b) => gcd(a, b)) || 1;
  return `${keys.join('-')}\n${vals.map(v => v / g).join('-')}`;
}

export interface ShippingDocModel {
  order: any;
  seller: typeof EXPORT_SELLER;
  currency: { code: string; symbol: string; label: string };
  docMeta: any;
  plNumber: string;
  canSeeFin: boolean;
  plRows: Array<any>;
  plTotals: { cartons: number; qty: number; gross: number; net: number; vol: number };
  ciStyles: Array<any>;
  ciTotals: { cartons: number; qty: number; amount: number };
}

/** 装载出货单据模型(canSeeFin 由调用方按角色决定,决定是否带客户成交价)。 */
export async function loadShippingDocModel(
  supabase: any, orderId: string, canSeeFin: boolean, batchId?: string | null,
): Promise<{ data?: ShippingDocModel; error?: string }> {
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, po_number, customer_name, style_no, currency, etd, factory_date')
    .eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };

  // 分批:batchId 有值取该批装箱单;否则取整单(batch_id IS NULL)装箱单
  let plQ = (supabase.from('packing_lists') as any)
    .select('id, pl_number, doc_meta, batch_id').eq('order_id', orderId)
    .in('status', ['draft', 'confirmed', 'locked']);
  plQ = batchId ? plQ.eq('batch_id', batchId) : plQ.is('batch_id', null);
  const { data: pl } = await plQ.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pl) return { error: '尚未录入出货装箱数据' };

  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('*').eq('packing_list_id', pl.id).order('sequence_no', { ascending: true });
  if (!lines || lines.length === 0) return { error: '装箱单没有明细行,请先录入实发装箱数据' };

  // 主数据:款 → { 成分, 描述, 单位, 单价(gated) }
  const { data: oli } = await (supabase.from('order_line_items') as any)
    .select('style_no, product_name, product_name_en, fabric_name, unit, po_unit_price').eq('order_id', orderId);
  const styleMeta = new Map<string, any>();
  for (const r of (oli || [])) {
    if (!r.style_no) continue;
    const m = styleMeta.get(r.style_no) || {};
    if (!m.composition && r.fabric_name) m.composition = r.fabric_name;
    if (!m.description) m.description = r.product_name || r.product_name_en || '';
    if (!m.unit) m.unit = r.unit || '';
    if (m.po_unit_price == null && r.po_unit_price != null) m.po_unit_price = Number(r.po_unit_price);
    styleMeta.set(r.style_no, m);
  }

  const docMeta = { currency: order.currency || 'USD', ...(pl.doc_meta || {}) };
  const cur = (CURRENCY as any)[docMeta.currency] || CURRENCY.USD;
  const unitWord = (u: string) => (u && (u.includes('套') || u.toLowerCase() === 'set') ? 'SETS' : 'PCS');

  // ── PL 行(款×色)──
  const plRows: any[] = [];
  const plTotals = { cartons: 0, qty: 0, gross: 0, net: 0, vol: 0 };
  for (const l of lines) {
    const cartons = Number(l.carton_count) || 0;
    const per = Number(l.qty_per_carton) || 0;
    const qty = Number(l.total_qty) || 0;
    const d = l.carton_dims_cm || {};
    const dl = Number(d.l) || 0, dw = Number(d.w) || 0, dh = Number(d.h) || 0;
    const grossTotal = Math.round(cartons * (Number(l.gross_weight_per_carton) || 0) * 10) / 10;
    const netTotal = Math.round(cartons * (Number(l.net_weight_per_carton) || 0) * 10) / 10;
    const vol = dl && dw && dh ? Math.round((dl * dw * dh) * cartons / 1_000_000 * 1000) / 1000 : 0;
    plTotals.cartons += cartons; plTotals.qty += qty; plTotals.gross += grossTotal; plTotals.net += netTotal; plTotals.vol += vol;
    plRows.push({
      style_no: l.style_no || '', composition: styleMeta.get(l.style_no)?.composition || '',
      sizeText: sizeRatioText(l.size_breakdown), color: l.color || '',
      cartons, per, qty, dl, dw, dh, grossTotal, vol,
    });
  }

  // ── CI 行(按款汇总,颜色分布成一格)──
  const byStyle = new Map<string, any>();
  for (const l of lines) {
    const s = l.style_no || '';
    let g = byStyle.get(s);
    if (!g) g = { style_no: s, cartons: 0, qty: 0, per: Number(l.qty_per_carton) || 0, colors: [], sizes: {}, gross: 0, net: 0, vol: 0 };
    const cc = Number(l.carton_count) || 0;
    g.cartons += cc;
    g.qty += Number(l.total_qty) || 0;
    g.gross += cc * (Number(l.gross_weight_per_carton) || 0);
    g.net += cc * (Number(l.net_weight_per_carton) || 0);
    const d = l.carton_dims_cm || {};
    if (d.l && d.w && d.h) g.vol += (Number(d.l) * Number(d.w) * Number(d.h)) * cc / 1_000_000;
    if (!g.per && Number(l.qty_per_carton) > 0) g.per = Number(l.qty_per_carton);
    if (l.color) g.colors.push({ color: l.color, qty: Number(l.total_qty) || 0 });
    const sb = l.size_breakdown || {};
    for (const k of Object.keys(sb)) g.sizes[k] = (g.sizes[k] || 0) + (Number(sb[k]) || 0);
    byStyle.set(s, g);
  }
  const ciStyles: any[] = [];
  // missingPrice(修 P2 2026-07-09):有量却缺客户成交价的款数(仅 canSeeFin 有意义)——此前静默不计入
  // 总额、发票金额虚低且无警示。据此在 CI 页/导出显著提示,不再默默漏总。
  const ciTotals = { cartons: 0, qty: 0, amount: 0, missingPrice: 0 };
  for (const g of byStyle.values()) {
    const m = styleMeta.get(g.style_no) || {};
    const uw = unitWord(m.unit);
    const price = canSeeFin ? (m.po_unit_price ?? null) : null;
    const amount = price != null ? Math.round(price * g.qty * 100) / 100 : null;
    ciTotals.cartons += g.cartons; ciTotals.qty += g.qty;
    if (amount != null) ciTotals.amount += amount;
    else if (canSeeFin && g.qty > 0) ciTotals.missingPrice += 1;
    ciStyles.push({
      style_no: g.style_no, description: m.description || '', composition: m.composition || '',
      sizeRatio: sizeRatioText(g.sizes),
      colorBreakdown: g.colors.map((c: any) => `${c.color}(${c.qty}${uw})`).join('\n'),
      cartons: g.cartons, per: g.per, qty: g.qty, unitWord: uw,
      gross: Math.round(g.gross * 10) / 10, net: Math.round(g.net * 10) / 10, vol: Math.round(g.vol * 1000) / 1000,
      unitPrice: price, amount,
    });
  }
  ciTotals.amount = Math.round(ciTotals.amount * 100) / 100;

  return { data: { order, seller: EXPORT_SELLER, currency: cur, docMeta, plNumber: pl.pl_number, canSeeFin, plRows, plTotals, ciStyles, ciTotals } };
}
