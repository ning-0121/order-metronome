import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { isMilestoneOverdue } from '@/lib/domain/milestone-helpers';
import { formatDate } from '@/lib/utils/date';
import Link from 'next/link';
import { UnblockButton } from '@/components/UnblockButton';

// 获取今日日期（仅日期部分，用于比较）
function getTodayDateString(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString().split('T')[0];
}

// 判断日期是否为今天
function isToday(dateString: string | null): boolean {
  if (!dateString) return false;
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() === today.getTime();
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

  const today = getTodayDateString();

  // 模块 0：待复盘订单（最高优先级）- retrospective_required=true 且 retrospective_completed_at is null
  const { data: pendingRetroOrders } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('retrospective_required', true)
    .is('retrospective_completed_at', null)
    .order('created_at', { ascending: false });

  // 模块 1：今日到期（due_at = today, status != '已完成'）
  // 使用日期范围查询：从今天 00:00:00 到明天 00:00:00（不包含）
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  
  const { data: todayDueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`
      *,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    `)
    .gte('due_at', `${today}T00:00:00`)
    .lt('due_at', `${tomorrowStr}T00:00:00`)
    .neq('status', '已完成')
    .order('due_at', { ascending: true });

  // 模块 2：已超期（due_at < today, status != '已完成'）- 优先级最高
  const { data: overdueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`
      *,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    `)
    .lt('due_at', `${today}T00:00:00`)
    .neq('status', '已完成')
    .order('due_at', { ascending: true });

  // 模块 3：卡住清单（status = '卡住'）
  const { data: blockedMilestones } = await (supabase
    .from('milestones') as any)
    .select(`
      *,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    `)
    .eq('status', '卡住')
    .order('created_at', { ascending: false });

  // 模块 4：依赖阻塞/违规推进（depends_on 未完成但后续 gate 被推进）
  // 查询所有状态为"进行中"的里程碑，检查其依赖是否已完成
  const { data: inProgressMilestones } = await (supabase
    .from('milestones') as any)
    .select(`
      *,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    `)
    .eq('status', '进行中')
    .order('created_at', { ascending: false });

  // 检查依赖阻塞：找出依赖未完成但状态是"进行中"的 Gate
  const dependencyViolations: any[] = [];
  if (inProgressMilestones) {
    for (const milestone of inProgressMilestones) {
      // 如果 milestone 有 depends_on 字段（JSON 数组或字符串）
      let dependsOn: string[] = [];
      if (milestone.depends_on) {
        if (Array.isArray(milestone.depends_on)) {
          dependsOn = milestone.depends_on;
        } else if (typeof milestone.depends_on === 'string') {
          try {
            dependsOn = JSON.parse(milestone.depends_on);
          } catch {
            // 如果不是 JSON，跳过
            continue;
          }
        }
      }

      if (dependsOn.length > 0) {
        // 查询依赖的 Gate 状态
        const { data: dependentGates } = await (supabase
          .from('milestones') as any)
          .select('step_key, status, required, name')
          .eq('order_id', milestone.order_id)
          .in('step_key', dependsOn);

        if (dependentGates && dependentGates.length > 0) {
          // 检查是否有 required 依赖未完成
          // 注意：status 可能是数据库枚举值（'done'）或中文（'已完成'）
          const incompleteRequired = dependentGates.filter(
            (dep: any) => {
              const isRequired = dep.required === true || dep.required === 'true';
              const isDone = dep.status === 'done' || dep.status === '已完成';
              return isRequired && !isDone;
            }
          );

          if (incompleteRequired.length > 0) {
            dependencyViolations.push({
              ...milestone,
              incompleteDependencies: incompleteRequired.map((d: any) => d.name || d.step_key),
            });
          }
        }
      }
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">异常驱动 Dashboard</h1>
        <p className="text-gray-600 mt-2">
          欢迎回来，{(profile as any)?.name || user.email}
        </p>
        <p className="text-sm text-gray-500 mt-1">
          这里只显示需要你关注的事项：待复盘、已超期、今日到期、卡住清单、依赖阻塞
        </p>
      </div>

      {/* 模块 0：待复盘订单（最高优先级，紫色高亮） */}
      {pendingRetroOrders && pendingRetroOrders.length > 0 && (
        <div className="rounded-lg border-2 border-purple-300 bg-purple-50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-purple-800">
              📋 待复盘订单（{pendingRetroOrders.length}）
            </h2>
            <span className="text-sm text-purple-700 font-medium">
              这些订单已结束但未复盘，管理上仍未闭环
            </span>
          </div>
          <div className="space-y-3">
            {pendingRetroOrders.map((order: any) => (
              <div
                key={order.id}
                className="bg-white rounded-lg border border-purple-200 p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <Link
                        href={`/orders/${order.id}/retrospective`}
                        className="font-semibold text-lg text-purple-800 hover:text-purple-900 hover:underline"
                      >
                        {order.order_no || '未知订单'}
                      </Link>
                      <span className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800">
                        待复盘
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <div>
                        <strong>客户：</strong>{order.customer_name}
                      </div>
                      {order.termination_type && (
                        <div>
                          <strong>终结方式：</strong>
                          {order.termination_type === '完成' ? '✅ 完成' : '❌ 取消'}
                        </div>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/orders/${order.id}/retrospective`}
                    className="ml-4 px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-sm font-medium"
                  >
                    去复盘（必做）
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 模块 2：已超期（优先级第二，红色高亮） */}
      {overdueMilestones && overdueMilestones.length > 0 && (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-red-800">
              ⚠️ 已超期（{overdueMilestones.length}）
            </h2>
            <span className="text-sm text-red-700 font-medium">
              这是当前最需要处理的事项
            </span>
          </div>
          <div className="space-y-3">
            {overdueMilestones.map((milestone: any) => {
              const order = milestone.orders;
              return (
                <div
                  key={milestone.id}
                  className="bg-white rounded-lg border border-red-200 p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Link
                          href={`/orders/${order?.id}#milestone-${milestone.id}`}
                          className="font-semibold text-lg text-red-800 hover:text-red-900 hover:underline"
                        >
                          {order?.order_no || '未知订单'}
                        </Link>
                        <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-800">
                          已超期
                        </span>
                      </div>
                      <div className="text-gray-700 mb-1">
                        <strong>执行步骤：</strong>{milestone.name}
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        <div>
                          <strong>负责人角色：</strong>{milestone.owner_role}
                        </div>
                        <div>
                          <strong>截止日期：</strong>
                          {milestone.due_at ? formatDate(milestone.due_at) : '未设置'}
                        </div>
                        {order?.customer_name && (
                          <div>
                            <strong>客户：</strong>{order.customer_name}
                          </div>
                        )}
                      </div>
                    </div>
                    <Link
                      href={`/orders/${order?.id}#milestone-${milestone.id}`}
                      className="ml-4 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm font-medium"
                    >
                      查看订单
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 模块 1：今日到期 */}
      {todayDueMilestones && todayDueMilestones.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <h2 className="text-2xl font-bold text-blue-800 mb-4">
            📅 今日到期（{todayDueMilestones.length}）
          </h2>
          <div className="space-y-3">
            {todayDueMilestones.map((milestone: any) => {
              const order = milestone.orders;
              return (
                <div
                  key={milestone.id}
                  className="bg-white rounded-lg border border-blue-200 p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Link
                          href={`/orders/${order?.id}#milestone-${milestone.id}`}
                          className="font-semibold text-lg text-blue-800 hover:text-blue-900 hover:underline"
                        >
                          {order?.order_no || '未知订单'}
                        </Link>
                        <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800">
                          今日到期
                        </span>
                      </div>
                      <div className="text-gray-700 mb-1">
                        <strong>执行步骤：</strong>{milestone.name}
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        <div>
                          <strong>负责人角色：</strong>{milestone.owner_role}
                        </div>
                        <div>
                          <strong>截止日期：</strong>
                          {milestone.due_at ? formatDate(milestone.due_at) : '未设置'}
                        </div>
                        {order?.customer_name && (
                          <div>
                            <strong>客户：</strong>{order.customer_name}
                          </div>
                        )}
                      </div>
                    </div>
                    <Link
                      href={`/orders/${order?.id}#milestone-${milestone.id}`}
                      className="ml-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
                    >
                      查看订单
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 模块 3：卡住清单 */}
      {blockedMilestones && blockedMilestones.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-6">
          <h2 className="text-2xl font-bold text-orange-800 mb-4">
            🚫 卡住清单（{blockedMilestones.length}）
          </h2>
          <div className="space-y-3">
            {blockedMilestones.map((milestone: any) => {
              const order = milestone.orders;
              // 提取卡住原因
              const blockedReason = milestone.notes?.startsWith('卡住原因：')
                ? milestone.notes.substring(5)
                : milestone.notes || '未填写原因';
              
              return (
                <div
                  key={milestone.id}
                  className="bg-white rounded-lg border border-orange-200 p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Link
                          href={`/orders/${order?.id}#milestone-${milestone.id}`}
                          className="font-semibold text-lg text-orange-800 hover:text-orange-900 hover:underline"
                        >
                          {order?.order_no || '未知订单'}
                        </Link>
                        <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-800">
                          卡住
                        </span>
                      </div>
                      <div className="text-gray-700 mb-1">
                        <strong>执行步骤：</strong>{milestone.name}
                      </div>
                      <div className="text-sm text-gray-600 space-y-1 mb-2">
                        <div>
                          <strong>负责人角色：</strong>{milestone.owner_role}
                        </div>
                        {order?.customer_name && (
                          <div>
                            <strong>客户：</strong>{order.customer_name}
                          </div>
                        )}
                      </div>
                      <div className="bg-orange-50 border border-orange-200 rounded p-3 mt-2">
                        <div className="text-sm font-medium text-orange-800 mb-1">
                          卡住原因：
                        </div>
                        <div className="text-sm text-orange-700">
                          {blockedReason}
                        </div>
                      </div>
                    </div>
                    <div className="ml-4 flex flex-col gap-2">
                      <UnblockButton milestoneId={milestone.id} />
                      <Link
                        href={`/orders/${order?.id}#milestone-${milestone.id}`}
                        className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm font-medium text-center"
                      >
                        查看订单
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 模块 4：依赖阻塞/违规推进 */}
      {dependencyViolations && dependencyViolations.length > 0 && (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 p-6">
          <h2 className="text-2xl font-bold text-red-800 mb-4">
            ⚠️ 依赖阻塞/违规推进（{dependencyViolations.length}）
          </h2>
          <p className="text-sm text-red-700 mb-4">
            以下控制点依赖的强制控制点尚未完成，但已被推进到"进行中"状态。需要立即处理。
          </p>
          <div className="space-y-3">
            {dependencyViolations.map((milestone: any) => {
              const order = milestone.orders;
              return (
                <div
                  key={milestone.id}
                  className="bg-white rounded-lg border-2 border-red-300 p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Link
                          href={`/orders/${order?.id}#milestone-${milestone.id}`}
                          className="font-semibold text-lg text-red-800 hover:text-red-900 hover:underline"
                        >
                          {order?.order_no || '未知订单'}
                        </Link>
                        <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 font-semibold">
                          违规推进
                        </span>
                      </div>
                      <div className="text-gray-700 mb-2">
                        <strong>控制点：</strong>{milestone.name}
                      </div>
                      <div className="text-sm text-red-700 mb-2 p-2 bg-red-50 rounded border border-red-200">
                        <strong>未完成的依赖：</strong>
                        <ul className="list-disc list-inside mt-1">
                          {milestone.incompleteDependencies?.map((dep: string, idx: number) => (
                            <li key={idx}>{dep}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        <div>
                          <strong>负责人角色：</strong>{milestone.owner_role}
                        </div>
                        {order?.customer_name && (
                          <div>
                            <strong>客户：</strong>{order.customer_name}
                          </div>
                        )}
                      </div>
                    </div>
                    <Link
                      href={`/orders/${order?.id}#milestone-${milestone.id}`}
                      className="ml-4 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm font-medium"
                    >
                      查看订单
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {(!pendingRetroOrders || pendingRetroOrders.length === 0) &&
       (!overdueMilestones || overdueMilestones.length === 0) &&
       (!todayDueMilestones || todayDueMilestones.length === 0) &&
       (!blockedMilestones || blockedMilestones.length === 0) &&
       (!dependencyViolations || dependencyViolations.length === 0) && (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">
            暂无异常事项
          </h2>
          <p className="text-gray-600 mb-6">
            所有执行步骤都在正常进行中，继续保持！
          </p>
          <Link
            href="/orders"
            className="inline-block px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            查看所有订单
          </Link>
        </div>
      )}
    </div>
  );
}
