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
