import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { SystemHealthClient } from './SystemHealthClient';

export default async function SystemHealthPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 取最近 30 份报告
  const { data: reports } = await (supabase.from('system_health_reports') as any)
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(30);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white text-xl">
            🛡
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">系统守护</h1>
            <p className="text-sm text-gray-500">
              每晚凌晨 22:00 自动跑 6 维度健康检查，保留 90 天报告
            </p>
          </div>
        </div>
      </div>

      <SystemHealthClient initialReports={(reports || []) as any[]} />
    </div>
  );
}
