import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getPendingApprovals, CATEGORY_META, type ApprovalCategory } from '@/lib/services/pending-approvals.service';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '待审批中心 — Order Metronome',
};

interface PageProps {
  searchParams?: Promise<{ category?: string }>;
}

export default async function PendingApprovalsPage({ searchParams }: PageProps) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 取角色
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name, display_name')
    .eq('user_id', user.id)
    .single();

  const roles: string[] =
    Array.isArray((profile as any)?.roles) && (profile as any).roles.length > 0
      ? (profile as any).roles
      : [(profile as any)?.role].filter(Boolean);

  const isAdmin = roles.includes('admin');
  const isFinance = roles.includes('finance');

  // 准入：admin / finance / production_manager / sales 都能看（看到的 actionable 不同）
  const allowedRoles = ['admin', 'finance', 'production_manager', 'sales', 'admin_assistant'];
  if (!roles.some(r => allowedRoles.includes(r))) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
            <p className="text-2xl mb-2">🔒</p>
            <p className="text-gray-700">此页面仅对 admin / finance / production_manager / sales 角色开放</p>
          </div>
        </div>
      </main>
    );
  }

  const result = await getPendingApprovals(supabase, { userId: user.id, roles });
  const data = result.ok
    ? result.data
    : { total: 0, byCategory: {} as any, actionableCount: 0, items: [] };

  // 类目筛选
  const params = (await searchParams) ?? {};
  const filter = (params.category || 'all') as ApprovalCategory | 'all';
  const visible = filter === 'all'
    ? data.items
    : data.items.filter(i => i.category === filter);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* 标题 */}
        <div className="mb-6">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">← 返回</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">⏳ 待审批中心</h1>
          <p className="text-sm text-gray-500 mt-1">
            共 <span className="font-semibold text-gray-900">{data.total}</span> 项待处理，
            其中 <span className="font-semibold text-blue-600">{data.actionableCount}</span> 项你有权处理
          </p>
        </div>

        {/* 类目卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          {(Object.keys(CATEGORY_META) as ApprovalCategory[]).map(cat => {
            const count = data.byCategory[cat] || 0;
            const meta = CATEGORY_META[cat];
            const isActive = filter === cat;
            return (
              <Link
                key={cat}
                href={`/admin/pending-approvals?category=${cat}`}
                className={`block p-3 rounded-xl border transition-all ${
                  isActive
                    ? 'ring-2 ring-blue-400 ' + meta.color
                    : count === 0
                      ? 'bg-white border-gray-100 opacity-50'
                      : meta.color + ' hover:shadow-sm'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{meta.label}</p>
                    <p className="text-xl font-bold">{count}</p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* 筛选状态 */}
        <div className="flex items-center gap-2 mb-4">
          <Link
            href="/admin/pending-approvals"
            className={`text-sm px-3 py-1.5 rounded-full font-medium ${
              filter === 'all' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            全部 {data.total}
          </Link>
          {filter !== 'all' && (
            <span className="text-sm text-gray-500">
              筛选：{CATEGORY_META[filter]?.label} · 共 {visible.length} 项
            </span>
          )}
        </div>

        {/* 列表 */}
        {visible.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-2">🎉</p>
            <p className="text-gray-700 font-medium">没有待处理项</p>
            <p className="text-sm text-gray-400 mt-1">{filter === 'all' ? '系统清爽' : '此类目暂无待审批'}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map(item => {
              const meta = CATEGORY_META[item.category];
              const ageColor =
                item.ageDays >= 7  ? 'text-red-600 font-semibold' :
                item.ageDays >= 3  ? 'text-amber-600' :
                'text-gray-400';
              return (
                <Link
                  key={`${item.category}-${item.id}`}
                  href={item.sourceUrl}
                  className="block bg-white rounded-xl border border-gray-100 p-4 hover:border-blue-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className={`text-xs font-medium px-2 py-1 rounded-full whitespace-nowrap ${meta.color}`}>
                      {meta.icon} {meta.label}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800 truncate">
                        {item.title}
                      </p>
                      {item.subtitle && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{item.subtitle}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2">
                        <span className={`text-xs ${ageColor}`}>
                          已等待 {item.ageDays} 天
                        </span>
                        {item.customerName && (
                          <span className="text-xs text-gray-400">客户：{item.customerName}</span>
                        )}
                        {!item.actionable && (
                          <span className="text-xs text-gray-400 italic">（你无权处理，仅查看）</span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-blue-600 flex-shrink-0">前往处理 →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
