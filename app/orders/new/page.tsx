/**
 * /orders/new —— Order Intake dual-mode 入口（PO-first + legacy 回退）。
 *
 * 复审 P1 修:此前是纯客户端页、无角色门禁 → production/QC/物流登录后能看到客户售价/报价快照。
 * 改为 server component 前置角色门禁,仅建单角色可进(与 createOrder 服务端权限一致),其余回工作台。
 * 数据层再由 listCustomerPOsForIntake / getApprovedQuoteForCompare 各自补角色校验(见对应 action)。
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OrderIntakeModeSelector } from '@/components/order/OrderIntakeModeSelector';

const CAN_CREATE_ORDER = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

export default async function NewOrderPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_CREATE_ORDER.includes(r))) redirect('/dashboard');
  return <OrderIntakeModeSelector />;
}
