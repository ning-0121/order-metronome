import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole, getUserRoles } from '@/lib/utils/user-role';
import { getCustomerSchedules } from '@/app/actions/customer-schedules';
import { CustomerSchedulesClient } from './CustomerSchedulesClient';

export const dynamic = 'force-dynamic';

export default async function CustomerSchedulesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  const roles = await getUserRoles(supabase, user.id);
  const canRead = isAdmin || roles.some(r => ['sales', 'merchandiser'].includes(r));
  if (!canRead) redirect('/dashboard');

  const result = await getCustomerSchedules();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white text-xl">
            🎼
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">客户节奏偏好</h1>
            <p className="text-sm text-gray-500">
              针对客户习惯配置专属排期规则（如 RAG 离厂前 1 天寄船样） · 新建订单自动应用
            </p>
          </div>
        </div>
      </div>

      <CustomerSchedulesClient
        initialRows={result.data || []}
        initialError={result.error}
      />
    </div>
  );
}
