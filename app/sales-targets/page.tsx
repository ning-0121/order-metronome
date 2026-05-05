import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { listTargets, listAllCustomersForTarget } from '@/app/actions/sales-targets';
import { TargetEditor } from '@/components/TargetEditor';

export const dynamic = 'force-dynamic';

export const metadata = { title: '客户年度销售目标 — Order Metronome' };

interface PageProps {
  searchParams?: Promise<{ year?: string }>;
}

export default async function SalesTargetsPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const isFinance = userRoles.includes('finance');
  const isSales = userRoles.includes('sales') || userRoles.includes('merchandiser');

  if (!isAdmin && !isFinance && !isSales) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
            <p className="text-2xl mb-2">🔒</p>
            <p className="text-gray-700">此页面仅对 admin / finance / sales 角色开放</p>
          </div>
        </div>
      </main>
    );
  }

  const sp = (await searchParams) ?? {};
  const year = parseInt(sp.year || String(new Date().getFullYear()), 10);

  const [targetsRes, customersRes] = await Promise.all([
    listTargets(year, { showAll: isAdmin }),
    isAdmin ? listAllCustomersForTarget() : Promise.resolve({ data: [] as any[] }),
  ]);
  const rows = targetsRes.data || [];
  const allCustomers = (customersRes.data || []) as { id: string; customer_name: string }[];

  // 总览数据
  const totalTarget = rows.reduce((s, r) => s + r.target_qty, 0);
  const totalActual = rows.reduce((s, r) => s + r.progress.actualQty, 0);
  const totalExpected = rows.reduce((s, r) => s + r.progress.expectedQty, 0);
  const overallPct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : 0;
  const overallPerf = totalExpected > 0 ? totalActual / totalExpected : 0;
  const fmtWan = (n: number) => `${(n / 10000).toFixed(1)} 万件`;

  const yearOptions = [year - 1, year, year + 1];

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* 标题 */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">← 返回</Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-2">🎯 客户年度销售目标</h1>
            <p className="text-sm text-gray-500 mt-1">
              {isAdmin
                ? 'CEO/管理员可设置各客户年度目标，系统每天自动计算进度与考评建议'
                : '查看你负责客户的年度目标进度'}
            </p>
          </div>
          <div className="flex gap-2">
            {yearOptions.map(y => (
              <Link
                key={y}
                href={`/sales-targets?year=${y}`}
                className={`text-sm px-3 py-1.5 rounded-full font-medium ${
                  y === year ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {y}
              </Link>
            ))}
          </div>
        </div>

        {/* 总览卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card label="目标总件数" value={fmtWan(totalTarget)} />
          <Card label="已完成件数" value={fmtWan(totalActual)} />
          <Card label="完成率" value={`${overallPct.toFixed(1)}%`} hint={overallPct >= 100 ? '🚀 已达标' : ''} />
          <Card
            label="整体节奏"
            value={overallPerf >= 0.9 ? '✅ 正常' : overallPerf >= 0.7 ? '🟡 略落后' : '🔴 落后'}
            hint={`vs 预期 ${(overallPerf * 100).toFixed(0)}%`}
          />
        </div>

        {/* CEO 设目标 */}
        {isAdmin && (
          <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">➕ 设置 / 修改目标</h2>
            <TargetEditor year={year} customers={allCustomers} />
          </div>
        )}

        {/* 列表 */}
        {rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-2">🎯</p>
            <p className="text-gray-700 font-medium">{year} 年暂无目标数据</p>
            <p className="text-sm text-gray-400 mt-1">
              {isAdmin ? '点击上方表单设置首个客户目标' : '管理员尚未为你负责的客户设置目标'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(r => {
              const ev = r.progress.evaluation;
              const colorClass = {
                green: 'border-green-300 bg-green-50',
                blue:  'border-blue-300 bg-blue-50',
                amber: 'border-amber-300 bg-amber-50',
                red:   'border-red-300 bg-red-50',
              }[ev.color];
              const barColor = {
                green: 'bg-green-500',
                blue:  'bg-blue-500',
                amber: 'bg-amber-500',
                red:   'bg-red-500',
              }[ev.color];
              const pct = Math.min(100, r.progress.progressPct * 100);

              return (
                <div key={r.customer_id} className={`bg-white rounded-xl border-2 ${colorClass} p-4`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{ev.emoji}</span>
                      <h3 className="font-semibold text-gray-900">{r.customer_name}</h3>
                      {r.isMyCustomer && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                          我负责
                        </span>
                      )}
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-white border`}>
                        {ev.label}
                      </span>
                    </div>
                    {r.target_qty > 0 && (
                      <div className="text-right">
                        <p className="text-xs text-gray-500">完成 / 目标</p>
                        <p className="text-sm font-semibold text-gray-900">
                          {fmtWan(r.progress.actualQty)} / {fmtWan(r.target_qty)}
                        </p>
                      </div>
                    )}
                  </div>

                  {r.target_qty > 0 ? (
                    <>
                      {/* 进度条 */}
                      <div className="relative w-full bg-gray-200 rounded-full h-2.5 mb-2">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                        {/* 预期标线 */}
                        <div
                          className="absolute top-0 h-full w-0.5 bg-gray-700"
                          style={{ left: `${Math.min(100, (r.progress.expectedQty / r.target_qty) * 100)}%` }}
                          title={`预期：${fmtWan(r.progress.expectedQty)}`}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-gray-500 mb-2">
                        <span>{(r.progress.progressPct * 100).toFixed(1)}% 完成</span>
                        <span>已过 {r.progress.daysElapsed}/{r.progress.daysInYear} 天 · 剩 {r.progress.daysRemaining} 天</span>
                      </div>
                      <p className="text-sm text-gray-700 leading-relaxed">{ev.suggestion}</p>
                      {r.notes && <p className="text-xs text-gray-500 mt-1.5 italic">备注：{r.notes}</p>}
                    </>
                  ) : (
                    <div className="text-sm text-gray-500">
                      暂未设置目标（实际 {fmtWan(r.progress.actualQty)}）
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}
