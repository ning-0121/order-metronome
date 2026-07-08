'use server';

/**
 * 报价基线(逐料)—— 冻结的成本单一真相。
 * 业务在报价/建单时逐料填 单耗 + 单价(+加工费),冻结成基线;
 * 供 BOM(超单耗)/核料(超单耗+超价)/财务(报价→预算)三点对照。
 * 存储:order_cost_baseline.quote_baseline_lines(jsonb) + cmt_factory_quote + baseline_frozen_*。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getUserRoles } from '@/lib/utils/user-role';
import { hasRoleInGroup, isAdminRole } from '@/lib/domain/roles';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';

export interface QuoteBaselineLine {
  style_no?: string | null;             // 款号(单耗按款不同)
  material_name: string;
  category?: string | null;
  color?: string | null;
  quote_consumption?: number | null;   // 报价单耗(单件用量)
  quote_unit_price?: number | null;     // 报价单价(冻结·超价对照)
  quote_unit?: string | null;
  supplier?: string | null;
  notes?: string | null;
}
export interface QuoteStyleBudget {
  style_no: string;
  cmt?: number | null;                  // 加工费
  trim_budget?: number | null;          // 辅料费用合计
  fabric_cost?: number | null;          // 面料成本
}

/** 可录入/编辑报价基线:业务/订单管理/admin(报价是业务出的)。 */
function canEditBaseline(roles: string[]): boolean {
  return roles.includes('admin')
    || roles.some((r) => ['sales', 'sales_manager', 'merchandiser', 'order_manager', 'admin_assistant'].includes(r));
}
/** 可见报价单价(=成本):录入方 + 财务 + 采购底价角色(对照用);生产/QC 不可见。 */
function canSeeBaselinePrice(roles: string[]): boolean {
  return canEditBaseline(roles)
    || isAdminRole(roles)
    || hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS')
    || hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

export async function getQuoteBaseline(orderId: string): Promise<{
  data?: { lines: QuoteBaselineLine[]; styleBudgets: QuoteStyleBudget[]; cmt_quote: number | null; frozen_at: string | null; can_edit: boolean; can_see_price: boolean };
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  const roles = await getUserRoles(supabase, user.id);
  const canPrice = canSeeBaselinePrice(roles);

  const { data } = await (supabase.from('order_cost_baseline') as any)
    .select('quote_baseline_lines, quote_style_budgets, cmt_factory_quote, baseline_frozen_at').eq('order_id', orderId).maybeSingle();

  const raw: QuoteBaselineLine[] = ((data as any)?.quote_baseline_lines as QuoteBaselineLine[]) || [];
  // 非价角色:剥离 quote_unit_price(报价单价 = 成本)
  const lines = canPrice ? raw : raw.map(({ quote_unit_price, ...rest }) => rest);
  // 款级预算(cmt/trim/fabric 都是成本)→ 非价角色不返回
  const styleBudgets: QuoteStyleBudget[] = canPrice ? (((data as any)?.quote_style_budgets as QuoteStyleBudget[]) || []) : [];
  return {
    data: {
      lines, styleBudgets,
      cmt_quote: canPrice ? ((data as any)?.cmt_factory_quote ?? null) : null,
      frozen_at: (data as any)?.baseline_frozen_at ?? null,
      can_edit: canEditBaseline(roles),
      can_see_price: canPrice,
    },
  };
}

/** exceljs 单元格取文本(富文本/公式)。 */
function xlsxCell(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t?.text ?? '').join('');
    if (o.result !== undefined) return o.result;
    if (o.text !== undefined) return o.text;
  }
  return v;
}

/**
 * 解析上传的内部成本核算单(报价单)→ 返回报价基线行 + 款预算(不落库,给前端预览确认)。
 * 纯代码(exceljs + parseCostSheet),零 AI/零 token。仅业务/订单管理/admin。
 */
export async function parseQuoteFile(base64: string, orderId?: string): Promise<{
  lines?: QuoteBaselineLine[]; styleBudgets?: QuoteStyleBudget[]; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  if (!canEditBaseline(roles)) return { error: '仅业务/订单管理/管理员可上传报价单' };
  const buf = Buffer.from(base64.replace(/^data:.*base64,/, ''), 'base64');
  const res = await parseQuoteBuffer(buf);
  // 面料单耗以富录入表逐款录入值为准(报价单单耗常两款相同像取平均)
  if (orderId && res.lines?.length) res.lines = await overrideFabricConsumptionByStyle(supabase, orderId, res.lines);
  return res;
}

/** buffer → 报价基线 lines(布料逐料) + styleBudgets(逐款辅料/加工)。纯解析,不写库(供人确认后冻结)。 */
async function parseQuoteBuffer(buf: Buffer): Promise<{ lines?: QuoteBaselineLine[]; styleBudgets?: QuoteStyleBudget[]; error?: string }> {
  try {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    if (!ws) return { error: '空文件' };
    const rows: unknown[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const arr: unknown[] = [];
      for (let c = 1; c <= ws.columnCount; c++) arr.push(xlsxCell(ws.getCell(r, c).value));
      rows.push(arr);
    }
    const { parseCostSheet } = await import('@/lib/services/quote-sheet-parser');
    const res = parseCostSheet(rows);
    if (res.headerRow === -1) return { error: '没识别到表头(需含 "STYLE" 列)。请确认是内部成本核算单。' };
    if (res.lines.length === 0) return { error: '识别到表头但没读到面料行,请检查文件或手工录入。' };
    const lines: QuoteBaselineLine[] = res.lines.map((l) => ({
      style_no: l.style_no, material_name: l.material_name, category: 'fabric', color: null,
      quote_consumption: l.quote_consumption, quote_unit_price: l.quote_unit_price,
      quote_unit: l.quote_unit, supplier: l.supplier, notes: l.composition || null,
    }));
    return { lines, styleBudgets: res.styleBudgets as QuoteStyleBudget[] };
  } catch (e) {
    return { error: '解析失败:' + (e instanceof Error ? e.message : String(e)) + '。可手工录入兜底。' };
  }
}

/**
 * 用富录入表(order_line_items)逐款录入的面料单耗,覆盖报价单解析出的面料单耗。
 * 报价单常只给一个统一/较粗的单件用量(两款相同,看着像"取平均"),采购要按每款真实单耗核采购总价,
 * 故以「每款录入时的单耗为准」(2026-07-08 用户拍板)。按款号匹配,只覆盖 fabric 行且该款有录入单耗时。
 */
async function overrideFabricConsumptionByStyle(client: any, orderId: string, lines: QuoteBaselineLine[]): Promise<QuoteBaselineLine[]> {
  try {
    const { data: li } = await (client.from('order_line_items') as any)
      .select('style_no, fabric_consumption').eq('order_id', orderId);
    const norm = (s: any) => String(s ?? '').trim().toLowerCase();
    const consByStyle = new Map<string, number>();
    for (const r of (li || [])) {
      const st = norm((r as any).style_no); const c = Number((r as any).fabric_consumption);
      if (st && c > 0 && !consByStyle.has(st)) consByStyle.set(st, c);
    }
    if (consByStyle.size === 0) return lines;
    return lines.map((l) => {
      if (norm(l.category) !== 'fabric') return l;
      const c = consByStyle.get(norm(l.style_no));
      return c != null ? { ...l, quote_consumption: c } : l;
    });
  } catch { return lines; }
}

/**
 * 一键从「建单已上传的内部成本核算单」解析报价基线(免重传)。
 * 拉 order_attachments(file_type=internal_quote)→下载→解析→返回 lines/styleBudgets(草稿,不写库)。
 * 业务在报价基线页核对(布料分类型·辅料总额)后点「冻结」才成真相。守 AI 治理:不自动改基线。
 */
export async function prefillBaselineFromOrderQuoteFile(orderId: string): Promise<{
  lines?: QuoteBaselineLine[]; styleBudgets?: QuoteStyleBudget[]; error?: string; fileName?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  if (!canEditBaseline(roles)) return { error: '仅业务/订单管理/管理员可操作' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权此订单' };

  const { data: att } = await (supabase.from('order_attachments') as any)
    .select('storage_path, file_name, file_type, created_at').eq('order_id', orderId).eq('file_type', 'internal_quote')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!(att as any)?.storage_path) return { error: '没找到建单上传的「内部成本核算单」附件。请用上方「上传报价单」手动传。' };

  const svc = createServiceRoleClient();
  const { data: file, error: dErr } = await svc.storage.from('order-docs').download((att as any).storage_path);
  if (dErr || !file) return { error: '下载附件失败:' + (dErr?.message || '未知') };
  const buf = Buffer.from(await (file as Blob).arrayBuffer());
  const res = await parseQuoteBuffer(buf);
  // 面料单耗以富录入表逐款录入值为准(报价单单耗常两款相同像取平均)
  if (res.lines?.length) res.lines = await overrideFabricConsumptionByStyle(supabase, orderId, res.lines);
  return { ...res, fileName: (att as any).file_name };
}

export async function saveQuoteBaseline(
  orderId: string,
  input: { cmt_quote?: number | null; lines: QuoteBaselineLine[]; styleBudgets?: QuoteStyleBudget[] },
): Promise<{ ok?: boolean; count?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  if (!canEditBaseline(roles)) return { error: '仅业务/订单管理/管理员可录入报价基线' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权操作此订单' };

  const lines = (input.lines || [])
    .filter((l) => (l.material_name || '').trim())
    .map((l) => ({
      style_no: (l.style_no || '').trim() || null,
      material_name: l.material_name.trim(),
      category: l.category || null,
      color: (l.color || '').trim() || null,
      quote_consumption: num(l.quote_consumption),
      quote_unit_price: num(l.quote_unit_price),
      quote_unit: (l.quote_unit || '').trim() || null,
      supplier: (l.supplier || '').trim() || null,
      notes: (l.notes || '').trim() || null,
    }));

  const styleBudgets = (input.styleBudgets || [])
    .filter((b) => (b.style_no || '').trim())
    .map((b) => ({
      style_no: b.style_no.trim(),
      cmt: num(b.cmt),
      trim_budget: num(b.trim_budget),
      fabric_cost: num(b.fabric_cost),
    }));

  // ── 派生成本缓存(2026-07-08 用户拍板:弃用旧「成本控制」,报价基线成为唯一源)──
  // 旧「成本控制」上传单会把 budget_fabric_amount/budget_fabric_kg/fabric_consumption_kg 写进
  // order_cost_baseline,被 profit.service(成本兜底)、order-financials、procurement(面料KG预警)、
  // supply-chain 读。弃用旧单后,这些必须由报价基线冻结时按逐款算出来喂,否则利润/预算断供。
  const { data: ord } = await (supabase.from('orders') as any).select('quantity').eq('id', orderId).maybeSingle();
  const orderQty = Number((ord as any)?.quantity) || 0;
  const { data: liRows } = await (supabase.from('order_line_items') as any).select('style_no, qty_pcs').eq('order_id', orderId);
  const normS = (s: any) => String(s ?? '').trim().toLowerCase();
  const qtyByStyle = new Map<string, number>();
  for (const li of (liRows || [])) qtyByStyle.set(normS((li as any).style_no), (qtyByStyle.get(normS((li as any).style_no)) || 0) + (Number((li as any).qty_pcs) || 0));
  const singleStyle = styleBudgets.length <= 1;
  const qtyFor = (styleNo: string | null): number => {
    const q = qtyByStyle.get(normS(styleNo));
    if (q && q > 0) return q;
    return singleStyle ? orderQty : 0;   // 单款单/无逐款件数 → 用整单数量兜底
  };

  // 面料成本总额:优先报价单自带的逐款「面料成本(件)」×该款件数(权威,不猜损耗);
  // 无逐款面料成本 → 退回按布料行 单耗×单价×件数 估。
  let budgetFabricAmount = 0; let hasFabricCost = false;
  for (const b of styleBudgets) {
    const fc = Number((b as any).fabric_cost);
    if (fc > 0) { hasFabricCost = true; budgetFabricAmount += fc * qtyFor((b as any).style_no); }
  }
  const fabricLines = lines.filter((l) => normS(l.category) === 'fabric');
  if (!hasFabricCost) {
    for (const l of fabricLines) {
      const cons = Number(l.quote_consumption) || 0; const price = Number(l.quote_unit_price) || 0;
      if (cons > 0 && price > 0) budgetFabricAmount += cons * price * (qtyFor(l.style_no) || orderQty);
    }
  }
  budgetFabricAmount = Math.round(budgetFabricAmount * 100) / 100;

  // 面料预算量(KG,给采购面料累计预警)与单件面料用量(供 supply-chain 显示)
  let budgetFabricKg = 0; let consPerPiece = 0;
  for (const l of fabricLines) {
    const cons = Number(l.quote_consumption) || 0; if (!(cons > 0)) continue;
    budgetFabricKg += cons * (qtyFor(l.style_no) || orderQty);
    consPerPiece += cons;
  }
  budgetFabricKg = Math.round(budgetFabricKg * 100) / 100;
  consPerPiece = Math.round(consPerPiece * 10000) / 10000;

  // 加工费:优先人填的整单「加工费(报价·元/件)」;留空且逐款有 cmt → 按件数加权(整单总加工费÷总件数),
  // 使 order-financials 的 cmt_factory_quote×qty = Σ(逐款cmt×款件数),不再是错误均值。
  let cmtQuote = num(input.cmt_quote);
  if (cmtQuote == null) {
    let cmtTotal = 0; let qSum = 0; let hasCmt = false;
    for (const b of styleBudgets) { const c = Number((b as any).cmt); const q = qtyFor((b as any).style_no); if (c > 0 && q > 0) { cmtTotal += c * q; qSum += q; hasCmt = true; } }
    if (hasCmt && qSum > 0) cmtQuote = Math.round(cmtTotal / qSum * 10000) / 10000;
  }

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    quote_baseline_lines: lines,
    quote_style_budgets: styleBudgets,
    cmt_factory_quote: cmtQuote,
    // 派生缓存(报价基线为唯一源;下游利润/预算/供应链读这些)
    budget_fabric_amount: budgetFabricAmount > 0 ? budgetFabricAmount : null,
    budget_fabric_kg: budgetFabricKg > 0 ? budgetFabricKg : null,
    fabric_consumption_kg: consPerPiece > 0 ? consPerPiece : null,
    baseline_frozen_at: now,
    baseline_frozen_by: user.id,
    updated_at: now,
  };

  const { data: existing } = await (supabase.from('order_cost_baseline') as any)
    .select('id').eq('order_id', orderId).maybeSingle();
  if (existing) {
    const { error } = await (supabase.from('order_cost_baseline') as any).update(payload).eq('order_id', orderId);
    if (error) return { error: error.message };
  } else {
    const { error } = await (supabase.from('order_cost_baseline') as any).insert({ order_id: orderId, ...payload });
    if (error) return { error: error.message };
  }
  // 冻结即触发利润重算(报价基线成本兜底喂 profit.service);失败不阻断冻结
  try {
    const { calculateProfitSnapshot } = await import('@/lib/services/profit.service');
    await calculateProfitSnapshot(supabase, { orderId, snapshotType: 'live' });
  } catch (e: any) { console.warn('[saveQuoteBaseline] 利润重算失败(不阻断):', e?.message); }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, count: lines.length };
}

/**
 * 重算订单预算缓存(2026-07-08 弃用报价基线后的新口径:预算来自采购核料业务填的真实物料)。
 * 面料预算 = Σ(materials_bom 布料行 大货单耗 × 预算单价 × 件数);cmt/辅料 = order_cost_baseline.quote_style_budgets 逐款。
 * 写 order_cost_baseline 的成本兜底缓存(budget_fabric_amount/budget_fabric_kg/fabric_consumption_kg/cmt_factory_quote),
 * 供 profit.service / order-financials / procurement / supply-chain 读;并触发利润重算。用 service-role(采购/业务都可触发)。
 */
export async function recomputeOrderBudgetCaches(orderId: string): Promise<{ ok?: boolean; error?: string }> {
  const svc = createServiceRoleClient();
  const normS = (s: any) => String(s ?? '').trim().toLowerCase();
  const { data: ord } = await (svc.from('orders') as any).select('quantity').eq('id', orderId).maybeSingle();
  const orderQty = Number((ord as any)?.quantity) || 0;

  // 件数:按 款×色 / 款 / 整单
  const { data: lis } = await (svc.from('order_line_items') as any).select('style_no, color_cn, color_en, qty_pcs').eq('order_id', orderId);
  const byStyle = new Map<string, number>(); const byStyleColor = new Map<string, number>();
  for (const li of (lis || [])) {
    const q = Number((li as any).qty_pcs) || 0; const st = normS((li as any).style_no);
    byStyle.set(st, (byStyle.get(st) || 0) + q);
    for (const col of [(li as any).color_cn, (li as any).color_en]) if (col) byStyleColor.set(`${st}¦${normS(col)}`, q);
  }
  const singleStyle = byStyle.size <= 1;
  const piecesForBom = (b: any): number => {
    const st = normS(b.style_no);
    if (b.style_no && b.color) { const v = byStyleColor.get(`${st}¦${normS(b.color)}`); if (v != null) return v; }
    if (b.style_no) { const v = byStyle.get(st); if (v) return v; }
    return orderQty;
  };
  const qtyForStyle = (st: string): number => { const q = byStyle.get(normS(st)); if (q && q > 0) return q; return singleStyle ? orderQty : 0; };

  // 面料预算(materials_bom 布料行:大货单耗 × 预算单价 × 件数)
  const { data: bom } = await (svc.from('materials_bom') as any).select('*').eq('order_id', orderId);
  let budgetFabricAmount = 0; let budgetFabricKg = 0; let consPerPiece = 0;
  for (const b of (bom || [])) {
    if ((b as any).material_type !== 'fabric' && (b as any).material_type !== 'lining') continue;
    const cons = Number((b as any).production_consumption) || 0;
    const price = Number((b as any).budget_unit_price) || 0;
    const pcs = piecesForBom(b);
    if (cons > 0 && pcs > 0) { budgetFabricKg += cons * pcs; consPerPiece += cons; if (price > 0) budgetFabricAmount += cons * price * pcs; }
  }
  budgetFabricAmount = Math.round(budgetFabricAmount * 100) / 100;
  budgetFabricKg = Math.round(budgetFabricKg * 100) / 100;
  consPerPiece = Math.round(consPerPiece * 10000) / 10000;

  // 加工费(逐款 cmt 按件数加权 → cmt_factory_quote × 总件数 = Σ 款cmt×款件数)
  const { data: cb } = await (svc.from('order_cost_baseline') as any).select('id, quote_style_budgets').eq('order_id', orderId).maybeSingle();
  const styleBudgets: any[] = (cb as any)?.quote_style_budgets || [];
  let cmtTotal = 0; let qSum = 0;
  for (const b of styleBudgets) { const c = Number(b.cmt); const q = qtyForStyle(b.style_no); if (c > 0 && q > 0) { cmtTotal += c * q; qSum += q; } }
  const cmtQuote = qSum > 0 ? Math.round(cmtTotal / qSum * 10000) / 10000 : null;

  const payload: Record<string, unknown> = {
    budget_fabric_amount: budgetFabricAmount > 0 ? budgetFabricAmount : null,
    budget_fabric_kg: budgetFabricKg > 0 ? budgetFabricKg : null,
    fabric_consumption_kg: consPerPiece > 0 ? consPerPiece : null,
    cmt_factory_quote: cmtQuote,
    updated_at: new Date().toISOString(),
  };
  if ((cb as any)?.id) {
    const { error } = await (svc.from('order_cost_baseline') as any).update(payload).eq('order_id', orderId);
    if (error) return { error: error.message };
  } else {
    const { error } = await (svc.from('order_cost_baseline') as any).insert({ order_id: orderId, ...payload });
    if (error) return { error: error.message };
  }
  try {
    const { calculateProfitSnapshot } = await import('@/lib/services/profit.service');
    const sb = await createClient();
    await calculateProfitSnapshot(sb, { orderId, snapshotType: 'live' });
  } catch (e: any) { console.warn('[recomputeOrderBudgetCaches] 利润重算失败(不阻断):', e?.message); }
  return { ok: true };
}
