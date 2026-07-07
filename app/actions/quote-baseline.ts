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
export async function parseQuoteFile(base64: string): Promise<{
  lines?: QuoteBaselineLine[]; styleBudgets?: QuoteStyleBudget[]; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  if (!canEditBaseline(roles)) return { error: '仅业务/订单管理/管理员可上传报价单' };
  const buf = Buffer.from(base64.replace(/^data:.*base64,/, ''), 'base64');
  return parseQuoteBuffer(buf);
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

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    quote_baseline_lines: lines,
    quote_style_budgets: styleBudgets,
    cmt_factory_quote: num(input.cmt_quote),
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
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, count: lines.length };
}
