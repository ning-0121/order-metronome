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
import { SampleRequestForm } from '@/components/order/SampleRequestForm';
import { hasRoleInGroup } from '@/lib/domain/roles';

const CAN_CREATE_ORDER = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ type?: string; draft?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_CREATE_ORDER.includes(r))) redirect('/dashboard');
  // 打样单走专属「打样申请单」表单(2026-07-27),不再套大货单表单
  const { type, draft } = await searchParams;
  if (type === 'sample') return <SampleRequestForm />;

  // 服务端预取(2026-08-06 性能):表单挂载原来要发 6 个 Server Action
  // (客户/工厂×2/模板/规则/订单号),而 Next 对同页 action **排队串行** ——
  // 义乌→美东每个 300-500ms,6 个攒成 3~6 秒转圈,就是「录之前卡半天」。
  // 这里在服务端一次并行取齐(函数↔库同区 58ms/次,并行一轮打完)随页面送达,
  // 表单挂载零请求。任何一路失败给空值,组件会退回原来的自取行为,不白屏。
  const [customersR, factoriesR, templatesR, overridesR, orderNoR] = await Promise.all([
    import('@/app/actions/customers').then((m) => m.getCustomers()).catch(() => ({ data: null })),
    import('@/app/actions/factories').then((m) => m.getFactories()).catch(() => ({ data: null })),
    import('@/app/actions/order-templates').then((m) => m.getActiveOrderTemplates()).catch(() => ({ data: null })),
    import('@/app/actions/form-field-rules').then((m) => m.getOrderFormOverrides(null)).catch(() => null),
    import('@/app/actions/orders').then((m) => m.preGenerateOrderNo()).catch(() => ({ orderNo: null })),
  ]);
  const prefetch = {
    customers: customersR.data ?? undefined,
    factories: factoriesR.data ?? undefined,
    templates: templatesR.data ?? undefined,
    overrides: overridesR ?? undefined,
    orderNo: (orderNoR as any)?.orderNo ?? undefined,
  };

  // 客户 PO 成交价仅 CAN_SEE_FINANCIALS 可见(merchandiser 能建单但不看价 → 红线)
  return <OrderIntakeModeSelector showPrice={hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS')} initialDraftId={draft || null} prefetch={prefetch} />;
}
