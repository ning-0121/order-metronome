import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getMyDashboard } from '@/app/actions/my-customers';

export const dynamic = 'force-dynamic';

export const metadata = { title: '我的客户面板 — Order Metronome' };

const fmtWan = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)} 万件` : `${n.toLocaleString('zh-CN')} 件`;

export default async function MyCustomersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('name, email')
    .eq('user_id', user.id)
    .single();
  const myName = (profile as any)?.name || (user.email?.split('@')[0]) || '我';

  const dashRes = await getMyDashboard();
  if (dashRes.error || !dashRes.data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
            <p className="text-gray-700">加载失败：{dashRes.error}</p>
          </div>
        </div>
      </main>
    );
  }
  const d = dashRes.data;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* 标题 */}
        <div className="mb-6">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">← 返回</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">👤 {myName} 的客户面板</h1>
          <p className="text-sm text-gray-500 mt-1">
            农历 {d.year} 年（{d.yearStart} 至 {new Date(new Date(d.yearEnd).getTime() - 86400000).toISOString().slice(0, 10)}）·
            数据按 <span className="text-amber-700 font-medium">中国农历新年</span> 划分
          </p>
        </div>

        {/* 顶部 4 卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card label="负责客户数" value={d.customerCount.toString()} hint={`本年下单 ${d.totalOrdersThisYear} 单`} />
          <Card label="已下单" value={fmtWan(d.totalActualQty)} hint="累计件数" highlight />
          <Card label="年度目标" value={d.totalTargetQty > 0 ? fmtWan(d.totalTargetQty) : '—'} hint={d.totalTargetQty === 0 ? '未设目标' : ''} />
          <Card
            label="完成率"
            value={d.totalTargetQty > 0 ? `${d.overallProgressPct.toFixed(1)}%` : '—'}
            hint={d.overallProgressPct >= 100 ? '🚀 已达标' : d.overallProgressPct >= 70 ? '✅ 进度正常' : d.overallProgressPct > 0 ? '🟡 落后' : ''}
            colorClass={d.overallProgressPct >= 90 ? 'text-green-700' : d.overallProgressPct >= 70 ? 'text-blue-700' : d.overallProgressPct > 0 ? 'text-amber-700' : 'text-gray-500'}
          />
        </div>

        {/* 增长趋势 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <TrendCard
            label="本周新增"
            value={d.thisWeekOrders}
            hint={`上周 ${d.lastWeekOrders} 单`}
            growth={d.weekGrowthPct}
            theme="indigo"
          />
          <TrendCard
            label="本月新增"
            value={d.thisMonthOrders}
            hint={`上月 ${d.lastMonthOrders} 单`}
            growth={d.monthGrowthPct}
            theme="blue"
          />
        </div>

        {/* 客户列表 */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">我负责的客户</h2>
          <Link href="/sales-targets" className="text-xs text-indigo-600 hover:text-indigo-800">
            查看全部目标 →
          </Link>
        </div>

        {d.customers.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-2">📋</p>
            <p className="text-gray-700 font-medium">本农历年还没有你负责的订单</p>
            <p className="text-sm text-gray-400 mt-1">下单后这里会自动出现客户进度</p>
          </div>
        ) : (
          <div className="space-y-2">
            {d.customers.map(c => (
              <CustomerCard key={c.customer_id} c={c} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════
function Card({
  label, value, hint, highlight, colorClass,
}: { label: string; value: string; hint?: string; highlight?: boolean; colorClass?: string }) {
  return (
    <div className={`bg-white rounded-xl border ${highlight ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-gray-100'} p-4`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorClass || 'text-gray-900'}`}>{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function TrendCard({
  label, value, hint, growth, theme,
}: { label: string; value: number; hint: string; growth: number; theme: 'indigo' | 'blue' }) {
  const bg = theme === 'indigo' ? 'from-indigo-50 to-blue-50 border-indigo-100' : 'from-blue-50 to-cyan-50 border-blue-100';
  const fg = theme === 'indigo' ? 'text-indigo-700' : 'text-blue-700';
  const arrow = growth > 0 ? '↑' : growth < 0 ? '↓' : '→';
  const arrowColor = growth > 0 ? 'text-green-600' : growth < 0 ? 'text-red-600' : 'text-gray-500';
  return (
    <div className={`bg-gradient-to-br ${bg} rounded-xl border p-4`}>
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-gray-500">{label}</p>
        <span className={`text-xs font-medium ${arrowColor}`}>
          {arrow} {Math.abs(growth)}%
        </span>
      </div>
      <p className={`text-3xl font-bold ${fg} mt-1`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{hint}</p>
    </div>
  );
}

function CustomerCard({ c }: { c: any }) {
  const ev = c.progress.evaluation;
  const colorClass = {
    green: 'border-green-300 bg-green-50',
    blue:  'border-blue-300 bg-blue-50',
    amber: 'border-amber-300 bg-amber-50',
    red:   'border-red-300 bg-red-50',
  }[ev.color as string] || 'border-gray-200 bg-white';
  const barColor = {
    green: 'bg-green-500',
    blue:  'bg-blue-500',
    amber: 'bg-amber-500',
    red:   'bg-red-500',
  }[ev.color as string] || 'bg-gray-400';
  const pct = Math.min(100, c.progress.progressPct * 100);
  const expectedPct = c.targetQty > 0
    ? Math.min(100, (c.progress.expectedQty / c.targetQty) * 100)
    : 0;

  return (
    <div className={`bg-white rounded-xl border-2 ${c.hasTarget ? colorClass : 'border-gray-100'} p-4`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {c.hasTarget && <span className="text-lg">{ev.emoji}</span>}
          <h3 className="font-semibold text-gray-900">{c.customer_name}</h3>
          <span className="text-[10px] text-gray-500">{c.totalOrdersThisYear} 单</span>
          {c.hasTarget && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white border">
              {ev.label}
            </span>
          )}
        </div>
        {c.hasTarget ? (
          <div className="text-right">
            <p className="text-xs text-gray-500">完成 / 目标</p>
            <p className="text-sm font-semibold text-gray-900">
              {fmtWan(c.actualQty)} / {fmtWan(c.targetQty)}
            </p>
          </div>
        ) : (
          <span className="text-xs text-gray-500">已下单 {fmtWan(c.actualQty)}</span>
        )}
      </div>

      {c.hasTarget && (
        <>
          <div className="relative w-full bg-gray-200 rounded-full h-2.5 mb-2">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
            <div
              className="absolute top-0 h-full w-0.5 bg-gray-700"
              style={{ left: `${expectedPct}%` }}
              title={`预期：${fmtWan(c.progress.expectedQty)}`}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mb-2">
            <span>{(c.progress.progressPct * 100).toFixed(1)}% 完成</span>
            <span>已过 {c.progress.daysElapsed}/{c.progress.daysInYear} 天 · 剩 {c.progress.daysRemaining} 天</span>
          </div>
          <p className="text-sm text-gray-700 leading-relaxed">{ev.suggestion}</p>
        </>
      )}
    </div>
  );
}
