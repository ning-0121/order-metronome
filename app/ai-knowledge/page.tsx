import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getKnowledgeStats, getCompanyProfile } from '@/app/actions/ai-knowledge';
import { KNOWLEDGE_TYPE_LABELS, KNOWLEDGE_SOURCE_LABELS, INDUSTRY_OPTIONS, SCALE_OPTIONS } from '@/lib/domain/ai-knowledge';
import { AIKnowledgeClient } from './client';

export default async function AIKnowledgePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [statsResult, profileResult] = await Promise.all([
    getKnowledgeStats(),
    getCompanyProfile(),
  ]);

  const stats = statsResult.data;
  const profile = profileResult.data;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            🧠 AI 知识库
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            统一数据采集通道 — 员工、客户、工厂、流程知识汇聚
          </p>
        </div>
      </div>

      {/* 公司画像卡片 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">🏢 公司画像（SaaS 行业标签）</h2>
        {profile ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">公司名称</span>
              <p className="font-medium">{profile.company_name}</p>
            </div>
            <div>
              <span className="text-gray-500">行业</span>
              <p className="font-medium">{INDUSTRY_OPTIONS.find(i => i.value === profile.industry)?.label || profile.industry}</p>
            </div>
            <div>
              <span className="text-gray-500">细分</span>
              <p className="font-medium">{profile.industry_sub || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500">规模</span>
              <p className="font-medium">{SCALE_OPTIONS.find(s => s.value === profile.company_scale)?.label || profile.company_scale}</p>
            </div>
            <div>
              <span className="text-gray-500">年订单量</span>
              <p className="font-medium">{profile.annual_order_volume || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500">主要市场</span>
              <p className="font-medium">{profile.main_markets?.join(', ') || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500">主营品类</span>
              <p className="font-medium">{profile.main_products?.join(', ') || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500">痛点标签</span>
              <p className="font-medium">{profile.pain_points?.join(', ') || '-'}</p>
            </div>
          </div>
        ) : (
          <p className="text-gray-400 text-sm">尚未配置公司画像，请在 Supabase 中初始化 company_profile 表</p>
        )}
      </div>

      {/* 知识库统计 */}
      {stats && (
        <>
          {/* 总览卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard label="知识总量" value={stats.total} color="indigo" />
            {Object.entries(stats.byType).map(([type, count]) => (
              <StatCard
                key={type}
                label={KNOWLEDGE_TYPE_LABELS[type as keyof typeof KNOWLEDGE_TYPE_LABELS] || type}
                value={count}
                color={type === 'customer' ? 'blue' : type === 'factory' ? 'orange' : type === 'process' ? 'green' : type === 'employee' ? 'purple' : 'gray'}
              />
            ))}
          </div>

          {/* 数据来源分布 */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">📊 数据来源分布</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.bySource).map(([source, count]) => (
                <div key={source} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-600">
                    {KNOWLEDGE_SOURCE_LABELS[source as keyof typeof KNOWLEDGE_SOURCE_LABELS] || source}
                  </span>
                  <span className="text-sm font-bold text-gray-900">{count}</span>
                </div>
              ))}
              {Object.keys(stats.bySource).length === 0 && (
                <p className="text-sm text-gray-400">暂无数据，请运行数据采集</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* 客户端交互部分：采集按钮 + 知识列表 + 搜索 */}
      <AIKnowledgeClient
        recentEntries={stats?.recentEntries || []}
        lastRuns={stats?.lastCollectionRuns || []}
      />
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    orange: 'bg-orange-50 text-orange-700 border-orange-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    gray: 'bg-gray-50 text-gray-700 border-gray-200',
  };
  return (
    <div className={`rounded-xl border p-4 ${colorMap[color] || colorMap.gray}`}>
      <p className="text-xs opacity-70">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
