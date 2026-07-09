import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { CalibrateClient } from './CalibrateClient';

export const metadata = { title: '批量进度校准 — QIMO OS' };

export default async function ProgressCalibratePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { isAdmin, roles } = await getCurrentUserRole(supabase);
  const isPM = (roles || []).includes('production_manager');
  if (!isAdmin && !isPM) redirect('/orders');

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <Link href="/orders" className="text-sm text-indigo-600 hover:underline">← 订单列表</Link>
      <h1 className="text-2xl font-bold text-gray-900 mt-2 mb-1">🎯 批量进度校准</h1>
      <p className="text-sm text-gray-500 mb-5">
        真实订单之前没人在系统里推进 → 早期节点全逾期 → 业务端一片"风险"。在这里一屏逐单确定实际到了哪个节点,
        之前阶段的风险一并关闭,之后按各自计划继续。仅 admin / 生产主管可用。
      </p>
      <CalibrateClient />
    </div>
  );
}
