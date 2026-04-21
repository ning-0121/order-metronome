import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getOverdueTriageList, getTransferCandidates } from '@/app/actions/overdue-triage';
import { OverdueTriageClient } from './OverdueTriageClient';

export const dynamic = 'force-dynamic';

export default async function OverdueTriagePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const [triage, candidates] = await Promise.all([
    getOverdueTriageList(),
    getTransferCandidates(),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-orange-600 text-white text-xl">
            🚨
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">逾期治理台</h1>
            <p className="text-sm text-gray-500">
              按"阻塞点"聚合逾期订单，一屏处理 · 不让任何订单挂超过 14 天
            </p>
          </div>
        </div>
      </div>

      <OverdueTriageClient
        initialRows={triage.data || []}
        initialSummary={triage.summary}
        initialError={triage.error}
        candidates={candidates.data || []}
      />
    </div>
  );
}
