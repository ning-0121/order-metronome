import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';
import Link from 'next/link';
import { UnblockButton } from '@/components/UnblockButton';

/** 角色中文名映射 */
const ROLE_LABELS: Record<string, string> = {
  sales: '业务', merchandiser: '跟单', finance: '财务', procurement: '采购',
  production: '生产', qc: '品控', quality: '品控',
  logistics: '物流', admin: '管理员', ceo: 'CEO',
};

/** 每日鼓励语（31条，保证一个月不重复） */
const DAILY_QUOTES = [
  '每一份细致的跟进，都是客户选择我们的理由。',
  '团队的默契，就是最强的交付保障。',
  '把每个节拍踩准，就是对专业最好的诠释。',
  '今天的坚持，是明天口碑的基石。',
  '信任是最好的效率，而信任来自每一次准时交付。',
  '困难的订单打磨团队，顺利的订单奖励团队。',
  '客户的满意，从我们每一个环节的用心开始。',
  '专注细节、追求极致，这就是我们的竞争力。',
  '每解决一个问题，团队就更强大一分。',
  '优秀不是偶然，是日复一日的高标准。',
  '你的每一次认真，都在为团队积累信誉。',
  '让流程为人服务，而不是让人为流程焦虑。',
  '今天的每一步推进，都在缩短与目标的距离。',
  '一个好团队的标志，是每个人都不需要被催。',
  '品质是做出来的，不是检出来的。',
  '最好的风控，是把问题消灭在发生之前。',
  '稳扎稳打，方能行稳致远。',
  '再复杂的订单，拆成节拍就变得清晰。',
  '你们的认真，客户看得到，市场也看得到。',
  '不怕问题多，怕的是问题没人管。',
  '每一次复盘，都是下一次成功的预演。',
  '效率来自流程，卓越来自态度。',
  '做难而正确的事，时间会给出答案。',
  '今天多走一步，明天就少一个风险。',
  '一个订单就是一份承诺，我们从不食言。',
  '追求准时，不是因为规定，是因为专业。',
  '最好的团队文化，是彼此成就。',
  '把标准当底线，把卓越当目标。',
  '每一次沟通都是机会，每一次跟进都有价值。',
  '细节决定品质，坚持成就卓越。',
  '今天又是充满干劲的一天，加油！',
];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function getDailyQuote(): string {
  const today = new Date();
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  return DAILY_QUOTES[dayOfYear % DAILY_QUOTES.length];
}

function formatToday(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function getTodayDateString(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString().split('T')[0];
}

/** 判断用户角色是否匹配里程碑 owner_role */
function isMyMilestone(milestone: any, userRoles: string[]): boolean {
  if (!milestone.owner_role) return false;
  const ownerRole = milestone.owner_role.toLowerCase();
  return userRoles.some(r => {
    const nr = r.toLowerCase();
    return nr === ownerRole
      || (ownerRole === 'qc' && nr === 'quality')
      || (ownerRole === 'quality' && nr === 'qc')
      || (ownerRole === 'sales' && nr === 'merchandiser')
      || (ownerRole === 'merchandiser' && nr === 'sales');
  });
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // 获取用户角色列表
  const userRoles: string[] = (() => {
    const p = profile as any;
    if (p?.roles?.length > 0) return p.roles;
    if (p?.role) return [p.role];
    return ['sales'];
  })();
  const isAdmin = userRoles.includes('admin');

  const today = getTodayDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // 待复盘订单
  const { data: pendingRetroOrders } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('retrospective_required', true)
    .is('retrospective_completed_at', null)
    .order('created_at', { ascending: false });

  // 今日到期
  const { data: todayDueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .gte('due_at', `${today}T00:00:00`)
    .lt('due_at', `${tomorrowStr}T00:00:00`)
    .not('status', 'in', '("done","已完成","completed")')
    .order('due_at', { ascending: true });

  // 已超期（全部）
  const { data: allOverdueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .lt('due_at', `${today}T00:00:00`)
    .not('status', 'in', '("done","已完成","completed")')
    .order('due_at', { ascending: true });

  // 区分「我的逾期」和「他人逾期」
  const myOverdue = (allOverdueMilestones || []).filter((m: any) => isAdmin || isMyMilestone(m, userRoles));
  const othersOverdue = isAdmin ? [] : (allOverdueMilestones || []).filter((m: any) => !isMyMilestone(m, userRoles));

  // 卡住清单
  const { data: blockedMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .in('status', ['blocked', '卡单', '卡住'])
    .order('created_at', { ascending: false });

  const totalIssues =
    (pendingRetroOrders?.length || 0) +
    (allOverdueMilestones?.length || 0) +
    (todayDueMilestones?.length || 0) +
    (blockedMilestones?.length || 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg mb-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {getGreeting()}，{(profile as any)?.name || (profile as any)?.full_name || user.email?.split('@')[0]}
            </h1>
            <p className="mt-2 text-indigo-100 text-sm leading-relaxed max-w-2xl italic">
              &ldquo;{getDailyQuote()}&rdquo;
            </p>
            <p className="mt-3 text-indigo-200 text-xs">
              {userRoles.map(r => ROLE_LABELS[r] || r).join('、')}
            </p>
          </div>
          <div className="text-right flex-shrink-0 ml-4">
            <p className="text-indigo-200 text-sm">{formatToday()}</p>
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="stat-card">
          <div className="stat-value text-red-600">{myOverdue.length}</div>
          <div className="stat-label">🔴 我的逾期</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-orange-500">{othersOverdue.length}</div>
          <div className="stat-label">⚠️ 他人逾期</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-blue-600">{todayDueMilestones?.length || 0}</div>
          <div className="stat-label">今日到期</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-orange-600">{blockedMilestones?.length || 0}</div>
          <div className="stat-label">阻塞中</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-purple-600">{pendingRetroOrders?.length || 0}</div>
          <div className="stat-label">待复盘</div>
        </div>
      </div>

      {/* All clear state */}
      {totalIssues === 0 && (
        <div className="section text-center py-16">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">暂无异常事项</h2>
          <p className="text-gray-500 mb-6">所有执行步骤都在正常进行中，继续保持！</p>
          <Link href="/orders" className="btn-primary inline-flex items-center gap-2">
            查看所有订单
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      )}

      {/* 🔴 我的逾期 - 最高优先级 */}
      {myOverdue.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-100">
              <span className="text-red-600">🔴</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-red-700">我的逾期</h2>
              <p className="text-sm text-gray-500">{myOverdue.length} 个节点需要你立即处理</p>
            </div>
          </div>
          <div className="space-y-3">
            {myOverdue.slice(0, 5).map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="danger"
                badge="我的逾期"
                isMine={true}
              />
            ))}
            {myOverdue.length > 5 && (
              <Link href="/orders" className="block text-center text-sm text-red-600 hover:text-red-700 font-medium py-2">
                查看全部 {myOverdue.length} 个我的逾期节点 →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* ⚠️ 他人逾期 - 可催促 */}
      {othersOverdue.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100">
              <span className="text-orange-500">⚠️</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-orange-700">他人逾期</h2>
              <p className="text-sm text-gray-500">{othersOverdue.length} 个其他部门节点逾期，可能影响你的后续工作</p>
            </div>
          </div>
          <div className="space-y-3">
            {othersOverdue.slice(0, 5).map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="warning"
                badge={`${ROLE_LABELS[milestone.owner_role] || milestone.owner_role}逾期`}
                isMine={false}
              />
            ))}
            {othersOverdue.length > 5 && (
              <Link href="/orders" className="block text-center text-sm text-orange-600 hover:text-orange-700 font-medium py-2">
                查看全部 {othersOverdue.length} 个他人逾期节点 →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* 今日到期 */}
      {todayDueMilestones && todayDueMilestones.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100">
              <span className="text-blue-600">📅</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">今日到期</h2>
              <p className="text-sm text-gray-500">{todayDueMilestones.length} 个节点今日截止</p>
            </div>
          </div>
          <div className="space-y-3">
            {todayDueMilestones.slice(0, 5).map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="info"
                badge="今日"
              />
            ))}
          </div>
        </div>
      )}

      {/* 卡住清单 */}
      {blockedMilestones && blockedMilestones.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100">
              <span className="text-orange-600">🚫</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">阻塞中</h2>
              <p className="text-sm text-gray-500">{blockedMilestones.length} 个节点被阻塞</p>
            </div>
          </div>
          <div className="space-y-3">
            {blockedMilestones.slice(0, 5).map((milestone: any) => (
              <BlockedMilestoneCard key={milestone.id} milestone={milestone} />
            ))}
          </div>
        </div>
      )}

      {/* 待复盘 */}
      {pendingRetroOrders && pendingRetroOrders.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-100">
              <span className="text-purple-600">📋</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">待复盘</h2>
              <p className="text-sm text-gray-500">{pendingRetroOrders.length} 个订单需要复盘</p>
            </div>
          </div>
          <div className="space-y-3">
            {pendingRetroOrders.slice(0, 5).map((order: any) => (
              <div key={order.id} className="flex items-center justify-between p-4 rounded-xl border border-gray-200 hover:border-purple-300 transition-colors">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{order.order_no}</span>
                    <span className="badge badge-info">待复盘</span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">客户: {order.customer_name}</p>
                </div>
                <Link
                  href={`/orders/${order.id}/retrospective`}
                  className="btn-primary text-sm py-2"
                >
                  去复盘
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MilestoneCard({ milestone, variant, badge, isMine }: { milestone: any; variant: 'danger' | 'info' | 'warning'; badge: string; isMine?: boolean }) {
  const order = milestone.orders;
  const borderClass = variant === 'danger' ? 'border-red-200 hover:border-red-300'
    : variant === 'warning' ? 'border-orange-200 hover:border-orange-300'
    : 'border-blue-200 hover:border-blue-300';
  const badgeClass = variant === 'danger' ? 'badge-danger'
    : variant === 'warning' ? 'bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded-full font-medium'
    : 'badge-info';

  const daysOverdue = milestone.due_at
    ? Math.max(1, Math.floor((new Date().getTime() - new Date(milestone.due_at).getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  return (
    <div className={`p-4 rounded-xl border ${borderClass} transition-all hover:shadow-sm`}>
      <div className="flex items-start justify-between">
        <Link
          href={`/orders/${order?.id}?tab=progress#milestone-${milestone.id}`}
          className="flex-1 min-w-0"
        >
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-medium text-gray-900 truncate">{order?.order_no}</span>
            <span className={badgeClass}>{badge}</span>
            {daysOverdue > 0 && (
              <span className="text-xs text-gray-500">已超 {daysOverdue} 天</span>
            )}
          </div>
          <p className="text-sm text-gray-700 mb-1">{milestone.name}</p>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>截止: {milestone.due_at ? formatDate(milestone.due_at) : '-'}</span>
            <span>负责: {ROLE_LABELS[milestone.owner_role] || milestone.owner_role}</span>
          </div>
        </Link>
        <div className="flex items-center gap-2 ml-3 flex-shrink-0">
          {isMine === true && (
            <Link
              href={`/orders/${order?.id}?tab=progress#milestone-${milestone.id}`}
              className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 font-medium"
            >
              去处理
            </Link>
          )}
          {isMine === false && (
            <span className="text-xs px-3 py-1.5 rounded-md bg-orange-100 text-orange-700 font-medium cursor-default">
              催一下
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockedMilestoneCard({ milestone }: { milestone: any }) {
  const order = milestone.orders;
  const blockedReason = milestone.notes?.startsWith('阻塞说明：')
    ? milestone.notes.substring(5)
    : milestone.notes || '未填写原因';

  return (
    <div className="p-4 rounded-xl border border-orange-200 hover:border-orange-300 transition-all">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-gray-900 truncate">{order?.order_no}</span>
            <span className="badge badge-warning">阻塞</span>
          </div>
          <p className="text-sm text-gray-700 mb-2">{milestone.name}</p>
          <div className="text-xs text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
            原因: {blockedReason}
          </div>
        </div>
        <div className="flex flex-col gap-2 ml-4">
          <UnblockButton milestoneId={milestone.id} />
          <Link
            href={`/orders/${order?.id}?tab=progress#milestone-${milestone.id}`}
            className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
          >
            查看 →
          </Link>
        </div>
      </div>
    </div>
  );
}
