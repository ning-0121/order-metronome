'use server';

/**
 * 报价员 — 服务动作
 *
 * 权限：CEO / 业务 / 财务 / 采购 都可以访问
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { generateQuoteWithRAG } from '@/lib/quoter/api';
import type { QuoteInput, QuoteOutput } from '@/lib/quoter/types';

const QUOTER_ROLES = ['admin', 'sales', 'merchandiser', 'finance', 'procurement'];

async function checkQuoterAccess(): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = userRoles.some((r: string) => QUOTER_ROLES.includes(r));
  if (!allowed) return { ok: false, error: '无权访问报价员' };
  return { ok: true, userId: user.id };
}

/**
 * 生成一个报价（不写入数据库，仅计算）
 */
export async function previewQuote(input: QuoteInput): Promise<{
  result?: QuoteOutput;
  error?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  try {
    const supabase = await createClient();
    const result = await generateQuoteWithRAG(supabase, input);
    return { result };
  } catch (e: any) {
    return { error: '报价计算失败：' + (e?.message || e) };
  }
}

/**
 * 保存一个报价到数据库
 */
export async function saveQuote(
  input: QuoteInput,
  result: QuoteOutput,
): Promise<{ error?: string; quoteNo?: string; id?: string }> {
  const auth = await checkQuoterAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();

  // 生成报价编号 QT-20260409-001
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await (supabase.from('quoter_quotes') as any)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const seq = String((count || 0) + 1).padStart(3, '0');
  const quoteNo = `QT-${today}-${seq}`;

  const { data, error } = await (supabase.from('quoter_quotes') as any)
    .insert({
      quote_no: quoteNo,
      customer_name: input.customer_name || null,
      style_no: input.style_no || null,
      style_name: input.style_name || null,
      garment_type: input.garment_type,
      garment_subtype: input.subtype || null,
      quantity: input.quantity || 0,
      size_distribution: input.size_distribution || null,
      fabric_type: input.fabric.fabric_type || null,
      fabric_composition: input.fabric.composition || null,
      fabric_width_cm: input.fabric.width_cm || null,
      fabric_price_per_kg: input.fabric.price_per_kg || null,
      fabric_consumption_kg: result.fabric.avg_kg,
      cmt_factory: input.cmt_factory || null,
      cmt_operations: result.cmt.operations,
      cmt_cost_per_piece: result.costs.cmt_rmb,
      trim_cost_per_piece: input.trim_cost_per_piece || 0,
      packing_cost_per_piece: input.packing_cost_per_piece || 0,
      logistics_cost_per_piece: input.logistics_cost_per_piece || 0,
      margin_rate: input.margin_rate ?? 15.0,
      total_cost_per_piece: result.costs.subtotal_rmb,
      quote_price_per_piece: result.quote_currency_per_piece,
      currency: input.currency || 'USD',
      exchange_rate: input.exchange_rate || 7.2,
      status: 'draft',
      created_by: auth.userId,
    })
    .select('id, quote_no')
    .single();

  if (error) return { error: '保存失败：' + error.message };

  revalidatePath('/quoter');
  return { quoteNo: (data as any).quote_no, id: (data as any).id };
}

/**
 * 查询报价列表（按创建时间倒序）
 */
export async function listQuotes(limit = 50): Promise<{
  data?: any[];
  error?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data, error } = await (supabase.from('quoter_quotes') as any)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { error: error.message };

  // 附带创建者姓名
  const rows = (data || []) as any[];
  const userIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))];
  if (userIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', userIds);
    const nameMap = new Map(
      (profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知']),
    );
    for (const r of rows) {
      r._creator_name = r.created_by ? nameMap.get(r.created_by) || '未知' : '未知';
    }
  }

  return { data: rows };
}

/**
 * 删除报价
 */
export async function deleteQuote(id: string): Promise<{ error?: string; success?: boolean }> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { error } = await (supabase.from('quoter_quotes') as any).delete().eq('id', id);
  if (error) return { error: error.message };

  revalidatePath('/quoter');
  return { success: true };
}

/**
 * 导出报价单 Excel（发给客户的正式报价单）
 */
export async function exportQuoteSheet(quoteId: string): Promise<{
  error?: string;
  base64?: string;
  fileName?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data: q } = await (supabase.from('quoter_quotes') as any)
    .select('*').eq('id', quoteId).single();
  if (!q) return { error: '报价不存在' };

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'Qimo Activewear';
  const ws = wb.addWorksheet('Quotation');

  // 标题
  ws.mergeCells('A1:F1');
  const title = ws.getCell('A1');
  title.value = 'YIWU QIMO CLOTHING CO., LTD — QUOTATION';
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 32;

  // 基本信息
  const info = [
    ['Quote No.', q.quote_no || '—'],
    ['Date', new Date(q.created_at).toLocaleDateString('en-US')],
    ['Customer', q.customer_name || '—'],
    ['Style', `${q.style_no || ''} ${q.style_name || ''}`],
    ['Quantity', `${q.quantity || 0} PCS`],
    ['Currency', q.currency || 'USD'],
  ];
  info.forEach(([label, value], i) => {
    const row = ws.getRow(i + 3);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true, color: { argb: 'FF374151' } };
    row.getCell(2).value = value;
  });

  // 报价明细
  const detailStart = 10;
  ws.getRow(detailStart).values = ['Item', 'Description', 'Unit Cost', 'Currency'];
  ws.getRow(detailStart).font = { bold: true };
  ws.getRow(detailStart).eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
  });

  const rate = q.exchange_rate || 7.2;
  const currency = q.currency || 'USD';
  const toC = (rmb: number) => currency === 'RMB' ? rmb : Number((rmb / rate).toFixed(3));

  const items = [
    ['Fabric', `${q.fabric_type || 'Main fabric'} (${q.fabric_consumption_kg?.toFixed(3) || '?'} KG/pc)`, toC(q.fabric_cost_per_piece || 0)],
    ['CMT', 'Cut, Make & Trim', toC(q.cmt_cost_per_piece || 0)],
    ['Trims', 'Labels, tags, accessories', toC(q.trim_cost_per_piece || 0)],
    ['Packing', 'Polybag, hangtag, carton', toC(q.packing_cost_per_piece || 0)],
    ['Logistics', 'Inland transport', toC(q.logistics_cost_per_piece || 0)],
  ];
  items.forEach(([item, desc, cost], i) => {
    const row = ws.getRow(detailStart + 1 + i);
    row.values = [item, desc, cost, currency];
  });

  // 合计
  const totalRow = ws.getRow(detailStart + 7);
  totalRow.values = ['', 'TOTAL PER PIECE', q.quote_price_per_piece || 0, currency];
  totalRow.font = { bold: true, size: 12 };
  totalRow.getCell(3).font = { bold: true, size: 14, color: { argb: 'FF4F46E5' } };

  const grandRow = ws.getRow(detailStart + 8);
  grandRow.values = ['', `TOTAL (${q.quantity || 0} PCS)`, Number(((q.quote_price_per_piece || 0) * (q.quantity || 0)).toFixed(2)), currency];
  grandRow.font = { bold: true };

  // 条款
  const termsStart = detailStart + 10;
  ws.getCell(`A${termsStart}`).value = 'Terms:';
  ws.getCell(`A${termsStart}`).font = { bold: true };
  ws.getCell(`A${termsStart + 1}`).value = '• Validity: 30 days from quote date';
  ws.getCell(`A${termsStart + 2}`).value = '• MOQ: As per discussion';
  ws.getCell(`A${termsStart + 3}`).value = '• Delivery: 45 days after PO confirmation';

  // 列宽
  [14, 30, 12, 8, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const fileName = `Quotation_${q.quote_no || 'draft'}_${q.customer_name || ''}.xlsx`;

  return { base64, fileName };
}

/**
 * 复制报价（基于现有报价创建新报价）
 */
export async function duplicateQuote(quoteId: string): Promise<{
  error?: string;
  newQuoteId?: string;
  newQuoteNo?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();
  const { data: original } = await (supabase.from('quoter_quotes') as any)
    .select('*').eq('id', quoteId).single();
  if (!original) return { error: '原报价不存在' };

  // 生成新报价号
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await (supabase.from('quoter_quotes') as any)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const seq = String((count || 0) + 1).padStart(3, '0');
  const quoteNo = `QT-${today}-${seq}`;

  const { id, quote_no, created_at, updated_at, fabric_cost_per_piece, ...fields } = original as any;

  const { data: newQ, error } = await (supabase.from('quoter_quotes') as any)
    .insert({
      ...fields,
      quote_no: quoteNo,
      status: 'draft',
      created_by: auth.userId,
      notes: `复制自 ${(original as any).quote_no}`,
    })
    .select('id, quote_no')
    .single();

  if (error) return { error: error.message };
  revalidatePath('/quoter');
  return { newQuoteId: (newQ as any).id, newQuoteNo: (newQ as any).quote_no };
}

/**
 * 报价转订单（成交后一键创建订单草稿）
 */
export async function convertQuoteToOrder(quoteId: string): Promise<{
  error?: string;
  orderId?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data: q } = await (supabase.from('quoter_quotes') as any)
    .select('*').eq('id', quoteId).single();
  if (!q) return { error: '报价不存在' };

  // 更新报价状态为 won
  await (supabase.from('quoter_quotes') as any)
    .update({ status: 'won', updated_at: new Date().toISOString() })
    .eq('id', quoteId);

  revalidatePath('/quoter');
  // 返回新建订单页 URL 带预填参数
  return {
    orderId: `/orders/new?customer=${encodeURIComponent((q as any).customer_name || '')}&style=${encodeURIComponent((q as any).style_no || '')}&qty=${(q as any).quantity || 0}&from_quote=${(q as any).quote_no}`,
  };
}

/**
 * 提交训练反馈（报价成交后对比实际成交价）
 */
export async function submitQuoteFeedback(
  quoteId: string,
  feedbackType: 'fabric_consumption' | 'cmt_cost' | 'total_price',
  actualValue: number,
): Promise<{ error?: string }> {
  const auth = await checkQuoterAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();
  const { data: q } = await (supabase.from('quoter_quotes') as any)
    .select('fabric_consumption_kg, cmt_cost_per_piece, quote_price_per_piece')
    .eq('id', quoteId).single();
  if (!q) return { error: '报价不存在' };

  const predictedMap: Record<string, number> = {
    fabric_consumption: (q as any).fabric_consumption_kg || 0,
    cmt_cost: (q as any).cmt_cost_per_piece || 0,
    total_price: (q as any).quote_price_per_piece || 0,
  };

  const { error } = await (supabase.from('quoter_training_feedback') as any).insert({
    quote_id: quoteId,
    feedback_type: feedbackType,
    predicted_value: predictedMap[feedbackType],
    actual_value: actualValue,
    corrected_by: auth.userId,
  });

  if (error) return { error: error.message };
  revalidatePath('/quoter');
  return {};
}

/**
 * 多报价对比（最多 5 个）
 */
export async function compareQuotes(quoteIds: string[]): Promise<{
  data?: any[];
  error?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };
  if (quoteIds.length > 5) return { error: '最多对比 5 个报价' };

  const supabase = await createClient();
  const { data, error } = await (supabase.from('quoter_quotes') as any)
    .select('*')
    .in('id', quoteIds);
  if (error) return { error: error.message };
  return { data: data || [] };
}

/**
 * 工价月度趋势（按品类）
 */
export async function getCmtTrend(garmentType?: string): Promise<{
  data?: Array<{ month: string; avgRate: number; count: number }>;
  error?: string;
}> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  let query = (supabase.from('quoter_cmt_training_samples') as any)
    .select('total_cmt_rmb, created_at, garment_type')
    .eq('status', 'confirmed')
    .not('total_cmt_rmb', 'is', null)
    .order('created_at', { ascending: true });

  if (garmentType) query = query.eq('garment_type', garmentType);

  const { data, error } = await query;
  if (error) return { error: error.message };

  // 按月分组
  const byMonth: Record<string, { total: number; count: number }> = {};
  for (const r of (data || []) as any[]) {
    const month = String(r.created_at).slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { total: 0, count: 0 };
    byMonth[month].total += r.total_cmt_rmb;
    byMonth[month].count++;
  }

  const trend = Object.entries(byMonth)
    .map(([month, { total, count }]) => ({
      month,
      avgRate: Number((total / count).toFixed(2)),
      count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return { data: trend };
}

/**
 * 更新报价状态（sent/won/lost/abandoned）
 */
export async function updateQuoteStatus(
  id: string,
  status: 'draft' | 'sent' | 'won' | 'lost' | 'abandoned',
): Promise<{ error?: string; success?: boolean }> {
  const auth = await checkQuoterAccess();
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { error } = await (supabase.from('quoter_quotes') as any)
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { error: error.message };

  revalidatePath('/quoter');
  return { success: true };
}
