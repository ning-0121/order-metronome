import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getDelayHotspots } from '@/app/actions/delay-hotspots';
import { DelayHotspotsClient } from './DelayHotspotsClient';

export const dynamic = 'force-dynamic';

export default async function DelayHotspotsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 默认近 30 天
  const result = await getDelayHotspots({ rangeDays: 30, minDelayDays: 1 });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-rose-600 text-white text-xl">
            📉
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">延误排行榜</h1>
            <p className="text-sm text-gray-500">
              已完成但逾期的关卡 · 强制归因 · 供复盘 + 考核 + 财务审计
            </p>
          </div>
        </div>
      </div>

      <DelayHotspotsClient
        initialRows={result.data || []}
        initialSummary={result.summary}
        initialError={result.error}
      />
    </div>
  );
}
