'use server';

/**
 * Order Intake — 只读支撑（PO 选择器数据）
 *
 * 唯一新增：列出 customer_po 供 UI 选择器。纯只读，不改任何既有 backend
 * （createOrder / kernel / router / PO 逻辑均不碰）。审批/快照真相仍走既有
 * getApprovedQuoteForCompare（消费闸门），本文件不做业务判断。
 */

import { createClient } from '@/lib/supabase/server';

export interface IntakePoRow {
  id: string;
  po_number: string;
  customer_id: string;
  quote_id: string;
  quote_snapshot_version: number;
  status: string;
  created_at: string;
}

const CAN_INTAKE_ROLES = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

export async function listCustomerPOsForIntake(limit = 50): Promise<{ data?: IntakePoRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  // 复审 P1:建单数据只给建单角色(与 /orders/new 页门禁 + createOrder 一致),防生产/QC/物流经此读到报价
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_INTAKE_ROLES.includes(r))) return { error: '无权访问建单数据' };

  const { data, error } = await (supabase.from('customer_po') as any)
    .select('id, po_number, customer_id, quote_id, quote_snapshot_version, status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { error: error.message };
  return { data: (data || []) as IntakePoRow[] };
}
