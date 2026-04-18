import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { OrderTemplatesClient } from './OrderTemplatesClient';
import { getAllOrderTemplates } from '@/app/actions/order-templates';

export default async function OrderTemplatesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const { data: templates } = await getAllOrderTemplates();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* 页头 */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-lg">
            📋
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">订单模板管理</h1>
            <p className="text-sm text-gray-500">预设常用订单参数，业务新建订单时一键套用</p>
          </div>
        </div>
      </div>

      <OrderTemplatesClient initialTemplates={templates || []} />
    </div>
  );
}
