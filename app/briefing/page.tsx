import { getTodayBriefing } from '@/app/actions/briefing';
import { BriefingCard } from '@/components/BriefingCard';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function BriefingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: briefing } = await getTodayBriefing();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📋 今日简报</h1>
          <p className="mt-1 text-sm text-gray-500">
            {briefing
              ? `${briefing.briefing_date} · ${briefing.total_emails}封邮件 · ${briefing.urgent_count}个紧急 · ${briefing.compliance_count}个偏差`
              : '暂无简报数据'}
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-600">← 返回首页</Link>
      </div>

      {briefing ? (
        <BriefingCard
          content={briefing.content}
          briefingDate={briefing.briefing_date}
        />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-400 text-lg">简报尚未生成</p>
          <p className="text-sm text-gray-400 mt-2">每日 08:00 自动生成，请稍后查看</p>
        </div>
      )}
    </div>
  );
}
