'use server';

import { createClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { loadShippingDocModel } from '@/lib/services/shipping-docs';
import { buildCommercialInvoiceWorkbook, buildCustomsWorkbook } from '@/lib/services/shipping-doc-builders';

async function canSeeFinOf(supabase: any, userId: string): Promise<boolean> {
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
}

/** 单据预览(PL + CI 结构化数据,供 UI 渲染 HTML 预览)。价列仅财务口径可见。 */
export async function previewShippingDocs(orderId: string, batchId?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  const { data, error } = await loadShippingDocModel(supabase, orderId, canSeeFin, batchId);
  if (error) return { error };
  return { data };
}

/**
 * CI 商业发票生成(ExcelJS,绮陌抬头)。按款汇总;单价取客户 PO 价(po_unit_price,仅财务口径);
 * 币种可选(USD/RMB);页脚 = 定金/尾款 + 付款条件/运费/出厂日 + 银行信息(业务填,存 doc_meta)。
 */
export async function generateCommercialInvoice(
  orderId: string, batchId?: string | null,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  if (!canSeeFin) return { error: 'CI 含客户成交价,仅财务/业务/管理员可生成' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, true, batchId);
  if (error || !m) return { error: error || '数据不足' };
  const { order } = m;

  const wb = await buildCommercialInvoiceWorkbook(m);
  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `CI - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}

/**
 * 报关资料生成(ExcelJS,4 sheet:报关单 + 箱单 + 发票 + 合同,义乌绮陌自营出口)。
 * 海关字段(HS编码/报关品名/规格/监管方式/成交方式等)存 doc_meta.customs,业务填、给默认。
 */
export async function generateCustomsDocs(
  orderId: string, batchId?: string | null,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const canSeeFin = await canSeeFinOf(supabase, user.id);
  if (!canSeeFin) return { error: '报关资料含成交价,仅财务/业务/管理员可生成' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, true, batchId);
  if (error || !m) return { error: error || '数据不足' };
  const { order } = m;

  const wb = await buildCustomsWorkbook(m);
  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `报关资料 - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
