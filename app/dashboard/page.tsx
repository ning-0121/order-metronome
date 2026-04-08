import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';
import Link from 'next/link';
import { UnblockButton } from '@/components/UnblockButton';
import { NudgeButton } from '@/components/NudgeButton';
import { DashboardAIAdvice } from '@/components/DashboardAIAdvice';

/** 角色中文名映射 */
const ROLE_LABELS: Record<string, string> = {
  sales: '业务/理单', merchandiser: '跟单', finance: '财务', procurement: '采购',
  production: '跟单', qc: '跟单', quality: '跟单',
  logistics: '物流/仓库', admin: '管理员',
};

/** 每日暖心语（31条，一个月不重复，不提工作，只关心人） */
const DAILY_QUOTES = [
  '今天也要好好吃饭哦，你值得被好好对待。',
  '不管昨天怎样，今天又是崭新的一天，你很棒。',
  '累了就歇一歇，照顾好自己才是最重要的事。',
  '你笑起来真好看，今天也要开开心心的。',
  '记得喝水，记得休息，记得你很重要。',
  '不用完美，做你自己就已经很好了。',
  '有你在的地方，就多了一份安心和温暖。',
  '今天天气不错，抬头看看窗外，深呼吸一下。',
  '你已经很努力了，允许自己偶尔放松一下吧。',
  '每一天都在变好，哪怕只是一点点，也很了不起。',
  '下班后给自己安排一点喜欢的事吧，你值得。',
  '你的存在本身就是一种力量，别忘了这一点。',
  '别太为难自己，很多事情慢慢来就好。',
  '今天也在认真生活的你，辛苦啦。',
  '希望今天的你，能遇到一件让你微笑的小事。',
  '不管多忙，都要记得吃早餐哦。',
  '你比你想象的更坚强，也比你以为的更温柔。',
  '偶尔停下来看看来时的路，你已经走了很远了。',
  '今天也要对自己好一点，你配得上所有美好。',
  '疲惫的时候想想让你开心的人和事，会好很多。',
  '世界很大，但此刻最重要的是你自己。',
  '你的付出都有意义，即使暂时看不到回报。',
  '给自己一个拥抱吧，你一直都很棒。',
  '今天的阳光是为你准备的，好好享受这一天。',
  '不必事事第一，健康快乐就是最好的成绩。',
  '有什么烦心事就放一放，明天又是新的开始。',
  '你的温柔和善良，身边的人都感受得到。',
  '生活不只有眼前的忙碌，还有很多值得期待的事。',
  '此刻的你正在被这个世界温柔以待，请相信。',
  '别忘了，家人朋友一直在你身后支持你。',
  '今天也是值得被好好珍惜的一天，加油鸭。',
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
  // 使用北京时间，避免 toISOString() 转换 UTC 导致凌晨日期错误
  const now = new Date();
  const year = now.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' });
  const month = now.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit' });
  const day = now.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', day: '2-digit' });
  return `${year}-${month}-${day}`;
}

/**
 * 判断一个里程碑是否属于"我的逾期"
 *
 * 定义（严格）：
 * 1. owner_user_id === 当前用户 → 直接是我的
 * 2. 他人负责的节点，但在某个我有未完成任务的订单里，
 *    且序号 ≤ 我自己在该订单里最早未完成任务的序号 → 卡在我前面，影响我
 *
 * 说明：不再按 role 匹配（role 只是标签，不代表责任人），
 *       生产主管/行政督办也用严格规则（他们不执行节点，就不背锅）。
 */
function isMyOrBlockingMe(
  milestone: any,
  userId: string,
  myMinSeqByOrder: Record<string, number>,
): boolean {
  if (milestone.owner_user_id === userId) return true;
  const myMinSeq = myMinSeqByOrder[milestone.order_id];
  if (myMinSeq === undefined) return false; // 这个订单和我无关
  if (milestone.sequence_number == null) return false;
  return milestone.sequence_number <= myMinSeq;
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
  const tomorrow = new Date(today + 'T00:00:00+08:00');
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
    .select(`*, orders!inner (id, order_no, customer_name, internal_order_no)`)
    .gte('due_at', `${today}T00:00:00`)
    .lt('due_at', `${tomorrowStr}T00:00:00`)
    .not('status', 'in', '("done","已完成","completed")')
    .order('due_at', { ascending: true });

  // 已超期（仅进行中的节点算逾期，未开始的不算）
  const { data: allOverdueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name, internal_order_no)`)
    .lt('due_at', `${today}T00:00:00`)
    .in('status', ['in_progress', '进行中'])
    .order('due_at', { ascending: true });

  // 获取当前用户涉及的订单 ID（创建的 + 被分配了关卡的）
  const { data: createdOrders } = await (supabase.from('orders') as any)
    .select('id').eq('owner_user_id', user.id);
  const { data: assignedMilestones } = await (supabase.from('milestones') as any)
    .select('order_id, sequence_number, status')
    .eq('owner_user_id', user.id);
  const myOrderIds = new Set([
    ...(createdOrders || []).map((o: any) => o.id),
    ...(assignedMilestones || []).map((m: any) => m.order_id),
  ]);

  // 计算每个订单里「我自己最早的未完成节点序号」
  // 用于判断：别人的逾期节点是否卡在我前面 → 影响我
  const DONE_STATUSES = new Set(['done', '已完成', 'completed']);
  const myMinSeqByOrder: Record<string, number> = {};
  for (const m of (assignedMilestones || []) as any[]) {
    if (DONE_STATUSES.has(m.status)) continue;
    if (m.sequence_number == null) continue;
    const cur = myMinSeqByOrder[m.order_id];
    if (cur === undefined || m.sequence_number < cur) {
      myMinSeqByOrder[m.order_id] = m.sequence_number;
    }
  }

  // 权限过滤：管理员/财务/行政/生产主管看所有订单，其他员工只看自己的
  const canSeeAll = isAdmin || userRoles.some(r => ['finance', 'admin_assistant', 'production_manager'].includes(r));
  const filterByMyOrders = (list: any[]) => canSeeAll ? list : list.filter((m: any) => myOrderIds.has(m.order_id));
  const filteredTodayDue = filterByMyOrders(todayDueMilestones || []);
  const filteredOverdue = filterByMyOrders(allOverdueMilestones || []);

  // 区分「我的逾期」（我负责 or 卡在我前面的）与「他人逾期」（剩余的）
  const myOverdue = isAdmin
    ? []
    : filteredOverdue.filter((m: any) => isMyOrBlockingMe(m, user.id, myMinSeqByOrder));
  const othersOverdue = isAdmin
    ? filteredOverdue
    : filteredOverdue.filter((m: any) => !isMyOrBlockingMe(m, user.id, myMinSeqByOrder));

  // 查询所有超期节点对应的延期申请状态
  const overdueMilestoneIds = filteredOverdue.map((m: any) => m.id);
  let delayRequestMap: Record<string, string> = {}; // milestoneId → status
  if (overdueMilestoneIds.length > 0) {
    const { data: delayReqs } = await (supabase.from('delay_requests') as any)
      .select('milestone_id, status')
      .in('milestone_id', overdueMilestoneIds)
      .in('status', ['pending', 'approved', 'rejected']);
    if (delayReqs) {
      for (const dr of delayReqs as any[]) {
        // 优先记录 approved > pending > rejected
        const current = delayRequestMap[dr.milestone_id];
        if (!current || dr.status === 'approved' || (dr.status === 'pending' && current === 'rejected')) {
          delayRequestMap[dr.milestone_id] = dr.status;
        }
      }
    }
  }

  // 获取逾期节点负责人姓名
  const ownerIds = [...new Set(filteredOverdue.map((m: any) => m.owner_user_id).filter(Boolean))];
  let ownerNameMap: Record<string, string> = {};
  if (ownerIds.length > 0) {
    const { data: ownerProfiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email').in('user_id', ownerIds);
    ownerNameMap = (ownerProfiles || []).reduce((m: any, p: any) => { m[p.user_id] = p.name || p.email?.split('@')[0]; return m; }, {});
  }
  // 将负责人名字附加到milestone对象上
  for (const m of filteredOverdue) {
    (m as any)._ownerName = m.owner_user_id ? ownerNameMap[m.owner_user_id] || null : null;
  }

  // 卡住清单
  const { data: rawBlockedMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name, internal_order_no)`)
    .in('status', ['blocked', '卡单', '卡住'])
    .order('created_at', { ascending: false });
  const blockedMilestones = filterByMyOrders(rawBlockedMilestones || []);

  const totalIssues =
    (pendingRetroOrders?.length || 0) +
    (allOverdueMilestones?.length || 0) +
    (filteredTodayDue.length || 0) +
    (blockedMilestones?.length || 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-50 to-white border border-slate-100 shadow-sm mb-8">
        {/* 左侧装饰条 */}
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-indigo-300 via-purple-300 to-pink-300" />
        <div className="p-6 pl-7">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-800">
                {getGreeting()}，{(profile as any)?.name || (profile as any)?.full_name || user.email?.split('@')[0]}
              </h1>
              <span className="text-2xl">
                {new Date().getHours() < 12 ? '🌅' : new Date().getHours() < 18 ? '☀️' : '🌙'}
              </span>
            </div>
            <p className="mt-3 text-sm text-gray-500 italic leading-relaxed max-w-2xl">
              {getDailyQuote()}
            </p>
            <p className="mt-4 text-xs text-gray-400">
              {userRoles.map(r => ROLE_LABELS[r] || r).join('、')}
            </p>
          </div>
          <div className="text-right flex-shrink-0 ml-6">
            <p className="text-sm font-medium text-gray-500">{formatToday()}</p>
          </div>
        </div>
        </div>
      </div>

      {/* AI 今日建议 */}
      <DashboardAIAdvice contextData={(() => {
        const parts: string[] = [];
        if (myOverdue.length > 0) parts.push(`我的逾期(${myOverdue.length}个): ${myOverdue.slice(0, 5).map((m: any) => `${m.orders?.order_no}-${m.name}(超${Math.ceil((new Date().getTime() - new Date(m.due_at).getTime()) / 86400000)}天)`).join('、')}`);
        if (othersOverdue.length > 0) parts.push(`他人逾期(${othersOverdue.length}个): ${othersOverdue.slice(0, 3).map((m: any) => `${m.orders?.order_no}-${m.name}(${m.owner_role})`).join('、')}`);
        if ((filteredTodayDue.length || 0) > 0) parts.push(`今日到期(${filteredTodayDue.length}个): ${(todayDueMilestones || []).slice(0, 3).map((m: any) => `${m.orders?.order_no}-${m.name}`).join('、')}`);
        if ((blockedMilestones?.length || 0) > 0) parts.push(`阻塞中(${blockedMilestones?.length}个)`);
        return parts.length > 0 ? parts.join('\n') : '';
      })()} />

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
          <div className="stat-value text-blue-600">{filteredTodayDue.length || 0}</div>
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

      {/* 角色专属快捷区 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-base">⚡</span>
          <h2 className="text-sm font-bold text-gray-900">
            {userRoles.includes('admin') || userRoles.includes('production_manager') || userRoles.includes('admin_assistant') ? '管理快捷入口' :
             userRoles.includes('sales') || userRoles.includes('merchandiser') ? '我的工作台' :
             userRoles.includes('finance') ? '财务工作台' :
             userRoles.includes('procurement') ? '采购工作台' :
             userRoles.includes('logistics') ? '物流工作台' : '工作台'}
          </h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {/* 所有角色通用 */}
          <Link href="/orders" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-indigo-50 text-sm text-gray-700 hover:text-indigo-700 transition-colors">
            <span>📦</span> 订单列表
          </Link>

          {/* 管理员/生产主管 */}
          {(userRoles.includes('admin') || userRoles.includes('production_manager')) && (
            <>
              <Link href="/ceo" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-red-50 text-sm text-gray-700 hover:text-red-700 transition-colors">
                <span>🎯</span> War Room
              </Link>
              <Link href="/analytics" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-purple-50 text-sm text-gray-700 hover:text-purple-700 transition-colors">
                <span>📊</span> 数据分析
              </Link>
              <Link href="/factories" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-amber-50 text-sm text-gray-700 hover:text-amber-700 transition-colors">
                <span>🏭</span> 工厂管理
              </Link>
            </>
          )}

          {/* 业务/跟单 */}
          {(userRoles.includes('sales') || userRoles.includes('merchandiser')) && (
            <>
              <Link href="/orders/new" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-green-50 text-sm text-gray-700 hover:text-green-700 transition-colors">
                <span>➕</span> 新建订单
              </Link>
              <Link href="/customers" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-blue-50 text-sm text-gray-700 hover:text-blue-700 transition-colors">
                <span>🤝</span> 客户管理
              </Link>
            </>
          )}

          {/* 财务 */}
          {userRoles.includes('finance') && (
            <>
              <Link href="/analytics" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-purple-50 text-sm text-gray-700 hover:text-purple-700 transition-colors">
                <span>📊</span> 数据分析
              </Link>
            </>
          )}

          {/* 采购 */}
          {userRoles.includes('procurement') && (
            <Link href="/factories" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-amber-50 text-sm text-gray-700 hover:text-amber-700 transition-colors">
              <span>🏭</span> 工厂/供应商
            </Link>
          )}

          {/* 物流 */}
          {userRoles.includes('logistics') && (
            <Link href="/warehouse" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-sky-50 text-sm text-gray-700 hover:text-sky-700 transition-colors">
              <span>🚚</span> 仓库/出货
            </Link>
          )}

          {/* 通用 */}
          <Link href="/memos" className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 text-sm text-gray-700 transition-colors">
            <span>📝</span> 备忘录
          </Link>
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
            {myOverdue.map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="danger"
                badge="我的逾期"
                isMine={true}
                delayStatus={delayRequestMap[milestone.id]}
              />
            ))}
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
            {othersOverdue.map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="warning"
                badge={`${ROLE_LABELS[milestone.owner_role] || milestone.owner_role}逾期`}
                isMine={false}
                delayStatus={delayRequestMap[milestone.id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* 今日到期 */}
      {filteredTodayDue.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100">
              <span className="text-blue-600">📅</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">今日到期</h2>
              <p className="text-sm text-gray-500">{filteredTodayDue.length} 个节点今日截止</p>
            </div>
          </div>
          <div className="space-y-3">
            {filteredTodayDue.slice(0, 5).map((milestone: any) => (
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

function MilestoneCard({ milestone, variant, badge, isMine, delayStatus }: { milestone: any; variant: 'danger' | 'info' | 'warning'; badge: string; isMine?: boolean; delayStatus?: string }) {
  const order = milestone.orders;
  const borderClass = variant === 'danger' ? 'border-red-200 hover:border-red-300'
    : variant === 'warning' ? 'border-orange-200 hover:border-orange-300'
    : 'border-blue-200 hover:border-blue-300';
  const badgeClass = variant === 'danger' ? 'badge-danger'
    : variant === 'warning' ? 'bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded-full font-medium'
    : 'badge-info';

  const daysOverdue = milestone.due_at
    ? Math.max(1, Math.ceil((new Date().getTime() - new Date(milestone.due_at).getTime()) / (24 * 60 * 60 * 1000)))
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
            {/* 延期申请状态标记 */}
            {variant !== 'info' && !delayStatus && daysOverdue > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">未申请延期</span>
            )}
            {delayStatus === 'pending' && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">延期待审批</span>
            )}
            {delayStatus === 'approved' && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">延期已批准</span>
            )}
          </div>
          <p className="text-sm text-gray-700 mb-1">{milestone.name} {order?.customer_name && <span className="text-gray-400">· {order.customer_name}</span>}</p>
          <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
            <span>截止: <span className="text-red-600 font-medium">{milestone.due_at ? formatDate(milestone.due_at) : '-'}</span></span>
            <span>负责: <span className="font-medium text-gray-700">{milestone._ownerName || ROLE_LABELS[milestone.owner_role] || milestone.owner_role}{milestone._ownerName ? `（${ROLE_LABELS[milestone.owner_role] || milestone.owner_role}）` : ''}</span></span>
            {order?.internal_order_no && <span>内部号: {order.internal_order_no}</span>}
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
            <NudgeButton milestoneId={milestone.id} milestoneName={milestone.name} />
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
