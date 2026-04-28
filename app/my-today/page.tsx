import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getDailyTasks, getTasksSummary, generateDailyTasks } from '@/lib/services/daily-tasks.service';
import { getPendingApprovalsCount } from '@/lib/services/pending-approvals.service';
import { TaskList } from '@/components/TaskList';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '今日任务 — Order Metronome',
};

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
];

function getDailyQuote(): string {
  const d = new Date();
  const idx = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
  return DAILY_QUOTES[idx % DAILY_QUOTES.length];
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '凌晨好';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function formatToday(): string {
  const d = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]}`;
}

export default async function MyTodayPage() {
  const supabase = await createClient();

  // 鉴权
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 读取用户名
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('display_name, role, roles')
    .eq('user_id', user.id)
    .single();

  const displayName = profile?.display_name ?? '同学';
  const userRoles: string[] =
    Array.isArray((profile as any)?.roles) && (profile as any).roles.length > 0
      ? (profile as any).roles
      : [(profile as any)?.role].filter(Boolean);

  // 待审批数量（聚合 6 个来源，仅展示 actionable 数）
  const approvalsResult = await getPendingApprovalsCount(supabase, { userId: user.id, roles: userRoles });
  const approvalsActionable = approvalsResult.ok ? approvalsResult.data.actionableCount : 0;
  const approvalsTotal = approvalsResult.ok ? approvalsResult.data.total : 0;

  // 按需触发任务生成（今日首次访问时生成）
  // 先查有没有今日任务，没有就生成
  const summaryResult = await getTasksSummary(supabase, user.id);
  const hasTasksToday = summaryResult.ok && summaryResult.data.total > 0;

  if (!hasTasksToday) {
    // 触发当日任务生成（仅限当前用户维度，用 daily_cron 全量生成）
    await generateDailyTasks(supabase, {
      trigger: 'daily_cron',
      date: new Date().toISOString().split('T')[0],
    });
  }

  // 读取任务列表
  const tasksResult = await getDailyTasks(supabase, user.id);
  const tasks = tasksResult.ok ? tasksResult.data : [];

  // 重新获取汇总（生成后）
  const summary = summaryResult.ok ? summaryResult.data : { total: tasks.length, urgent: 0, byType: {} };

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* 顶部问候 */}
        <div className="mb-8">
          <p className="text-sm text-gray-400">{formatToday()}</p>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">
            {getGreeting()}，{displayName} 👋
          </h1>
          <p className="text-sm text-gray-500 mt-2 italic">{getDailyQuote()}</p>
        </div>

        {/* 任务总览卡片 */}
        {tasks.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white rounded-xl p-4 text-center shadow-sm border border-gray-100">
              <p className="text-2xl font-bold text-gray-800">{tasks.length}</p>
              <p className="text-xs text-gray-500 mt-1">今日待办</p>
            </div>
            <div className={`rounded-xl p-4 text-center shadow-sm border ${
              summary.urgent > 0
                ? 'bg-red-50 border-red-200'
                : 'bg-white border-gray-100'
            }`}>
              <p className={`text-2xl font-bold ${summary.urgent > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {summary.urgent}
              </p>
              <p className="text-xs text-gray-500 mt-1">紧急</p>
            </div>
            <div className="bg-white rounded-xl p-4 text-center shadow-sm border border-gray-100">
              <p className="text-2xl font-bold text-gray-400">
                {tasks.filter(t => t.task_type === 'milestone_overdue' || t.task_type === 'milestone_due_today').length}
              </p>
              <p className="text-xs text-gray-500 mt-1">里程碑</p>
            </div>
          </div>
        )}

        {/* 待审批入口（仅当有待审批时显示） */}
        {approvalsTotal > 0 && (
          <a
            href="/admin/pending-approvals"
            className="block mb-4 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4 hover:shadow-sm transition-all"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">⏳</span>
                <div>
                  <p className="text-sm font-semibold text-purple-900">
                    {approvalsActionable > 0
                      ? `你有 ${approvalsActionable} 项待审批`
                      : `${approvalsTotal} 项待审批（暂无你能处理的）`}
                  </p>
                  <p className="text-xs text-purple-600 mt-0.5">
                    点击查看延期 / CEO批 / 价格 / Agent 建议 / 付款冻结 / 订单确认
                  </p>
                </div>
              </div>
              <span className="text-purple-600 text-sm font-medium">→</span>
            </div>
          </a>
        )}

        {/* 任务列表 */}
        <TaskList initialTasks={tasks} />

        {/* 底部快捷入口 */}
        <div className="mt-10 pt-6 border-t border-gray-200">
          <p className="text-xs text-gray-400 mb-3 font-medium uppercase tracking-wide">快速入口</p>
          <div className="grid grid-cols-3 gap-2">
            <a href="/orders" className="flex flex-col items-center gap-1 p-3 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors text-center">
              <span className="text-xl">📦</span>
              <span className="text-xs text-gray-600">全部订单</span>
            </a>
            <a href="/customers" className="flex flex-col items-center gap-1 p-3 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors text-center">
              <span className="text-xl">👥</span>
              <span className="text-xs text-gray-600">客户管理</span>
            </a>
            <a href="/dashboard" className="flex flex-col items-center gap-1 p-3 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors text-center">
              <span className="text-xl">📊</span>
              <span className="text-xs text-gray-600">数据看板</span>
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
