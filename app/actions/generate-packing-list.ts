'use server';

import { createClient } from '@/lib/supabase/server';
import { loadShippingDocModel } from '@/lib/services/shipping-docs';
import { buildPackingListWorkbook } from '@/lib/services/shipping-doc-builders';

/**
 * Packing List 生成器(ExcelJS,绮陌出口装箱单版式)。逐行=款×色;箱数/毛重/体积按实发现算;末行合计。
 * 数据统一走 loadShippingDocModel(与 CI/预览同源,永不偏差)。返回 { ok, base64, fileName }。
 */
export async function generatePackingList(
  orderId: string, batchId?: string | null,
): Promise<{ ok?: boolean; base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };

  const { data: m, error } = await loadShippingDocModel(supabase, orderId, false, batchId);  // PL 不含价
  if (error || !m) return { error: error || '数据不足' };
  const { order } = m;

  const wb = await buildPackingListWorkbook(m);
  const xlsxBuffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(xlsxBuffer).toString('base64');
  const fileName = `Packing List - ${order.internal_order_no || order.order_no || order.po_number || orderId}.xlsx`;
  return { ok: true, base64, fileName };
}
