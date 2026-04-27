// ============================================================
// Trade OS — Daily Tasks Service
// 职责：为每位用户生成今日待办任务（聚合 5 个来源）
// 原则：UNIQUE(assigned_to, source_type, source_id, task_date) 防重复
//       支持 cron 全量生成 + 事件触发增量生成
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import type {
  DailyTask,
  CreateTaskInput,
  TaskGenerationTrigger,
  TaskGenerationResult,
  TaskType,
  TaskPriority,
} from './types'

// ── 今日日期字符串 ─────────────────────────────────────────────
function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

// ─────────────────────────────────────────────────────────────
// upsertTask
// 写入单条任务，UNIQUE 约束冲突时静默跳过（视为正常）
// ─────────────────────────────────────────────────────────────
export async function upsertTask(
  supabase: SupabaseClient,
  input: CreateTaskInput
): Promise<ServiceResult<{ created: boolean }>> {
  const taskDate = input.taskDate ?? todayStr()

  const payload = {
    assigned_to: input.assignedTo,
    task_date: taskDate,
    task_type: input.taskType,
    priority: input.priority,
    title: input.title,
    description: input.description ?? null,
    action_url: input.actionUrl ?? null,
    action_label: input.actionLabel ?? '去处理',
    related_order_id: input.relatedOrderId ?? null,
    related_customer: input.relatedCustomer ?? null,
    related_milestone_id: input.relatedMilestoneId ?? null,
    source_type: input.sourceType,
    source_id: input.sourceId,
    status: 'pending',
  }

  const { error } = await (supabase.from('daily_tasks') as any)
    .insert(payload)

  if (error) {
    if (error.code === '23505') {  // UNIQUE 约束冲突 → 已存在，正常
      return ok({ created: false })
    }
    return err(`upsertTask failed: ${error.message}`, error.code)
  }

  return ok({ created: true })
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：获取用户 ID（按角色名）
// ─────────────────────────────────────────────────────────────
async function getUsersByRole(
  supabase: SupabaseClient,
  roles: string[]
): Promise<string[]> {
  const { data } = await (supabase.from('profiles') as any)
    .select('user_id, role, roles')

  if (!data) return []

  return data
    .filter((p: any) =>
      roles.includes(p.role) ||
      (Array.isArray(p.roles) && p.roles.some((r: string) => roles.includes(r)))
    )
    .map((p: any) => p.user_id as string)
}

// ─────────────────────────────────────────────────────────────
// generateMilestoneTasks
// 来源1：里程碑逾期 + 今日到期
// ─────────────────────────────────────────────────────────────
async function generateMilestoneTasks(
  supabase: SupabaseClient,
  targetDate: string
): Promise<TaskGenerationResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []

  // 读取所有未完成的里程碑（含负责人信息）
  const { data: milestones, error } = await (supabase.from('milestones') as any)
    .select(`
      id, step_key, step_name, planned_at, status,
      owner_id, owner_name,
      order_id,
      orders!inner(order_no, customer_name, lifecycle_status)
    `)
    .neq('status', 'done')
    .not('orders.lifecycle_status', 'in', '("completed","cancelled")')
    .not('planned_at', 'is', null)
    .lte('planned_at', new Date(new Date(targetDate).getTime() + 24 * 3600 * 1000).toISOString())

  if (error) {
    errors.push(`fetchMilestones: ${error.message}`)
    return { created, skipped, errors }
  }

  for (const ms of milestones || []) {
    if (!ms.owner_id) continue

    const order = ms.orders
    const plannedDate = new Date(ms.planned_at)
    const today = new Date(targetDate)
    const isOverdue = plannedDate < today
    const isDueToday = plannedDate.toISOString().split('T')[0] === targetDate

    const taskType: TaskType = isOverdue ? 'milestone_overdue' : 'milestone_due_today'
    const priority: TaskPriority = isOverdue ? 1 : 2
    const daysOverdue = isOverdue
      ? Math.floor((today.getTime() - plannedDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0

    const result = await upsertTask(supabase, {
      assignedTo: ms.owner_id,
      taskDate: targetDate,
      taskType,
      priority,
      title: isOverdue
        ? `【逾期${daysOverdue}天】${ms.step_name} — ${order.order_no}`
        : `【今日到期】${ms.step_name} — ${order.order_no}`,
      description: `客户：${order.customer_name}，计划日期：${ms.planned_at.split('T')[0]}`,
      actionUrl: `/orders/${ms.order_id}`,
      actionLabel: '查看订单',
      relatedOrderId: ms.order_id,
      relatedCustomer: order.customer_name,
      relatedMilestoneId: ms.id,
      sourceType: 'milestone',
      sourceId: ms.id,
    })

    if (result.ok) {
      if (result.data.created) created++
      else skipped++
    } else {
      errors.push(`milestone ${ms.id}: ${result.error}`)
    }
  }

  return { created, skipped, errors }
}

// ─────────────────────────────────────────────────────────────
// generateCustomerFollowupTasks
// 来源2：客户跟进提醒（due/overdue/at_risk）
// ─────────────────────────────────────────────────────────────
async function generateCustomerFollowupTasks(
  supabase: SupabaseClient,
  targetDate: string
): Promise<TaskGenerationResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []

  // 读取需要跟进的客户
  const { data: rhythms, error } = await (supabase.from('customer_rhythm') as any)
    .select('*')
    .in('followup_status', ['due', 'overdue', 'at_risk'])
    .neq('followup_status', 'inactive')

  if (error) {
    errors.push(`fetchRhythms: ${error.message}`)
    return { created, skipped, errors }
  }

  // 获取 sales 角色用户（客户跟进任务分配给 sales）
  const salesUsers = await getUsersByRole(supabase, ['sales', 'admin'])

  for (const rhythm of rhythms || []) {
    const priority: TaskPriority =
      rhythm.followup_status === 'at_risk' ? 1 :
      rhythm.followup_status === 'overdue' ? 2 : 3

    const statusLabel =
      rhythm.followup_status === 'at_risk' ? '⚠️ 高风险，立即联系' :
      rhythm.followup_status === 'overdue' ? '逾期，需联系' : '今日跟进'

    // 任务分配给所有 sales（多人可见，先到先得）
    for (const userId of salesUsers) {
      const result = await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: targetDate,
        taskType: 'customer_followup',
        priority,
        title: `${statusLabel}：${rhythm.customer_name}`,
        description: `风险评分 ${rhythm.risk_score}，上次联系：${
          rhythm.last_contact_at
            ? new Date(rhythm.last_contact_at).toLocaleDateString('zh-CN')
            : '无记录'
        }`,
        actionUrl: `/customers/${encodeURIComponent(rhythm.customer_name)}`,
        actionLabel: '查看客户',
        relatedCustomer: rhythm.customer_name,
        sourceType: 'customer_rhythm',
        sourceId: rhythm.id,
      })

      if (result.ok) {
        if (result.data.created) created++
        else skipped++
      } else {
        errors.push(`rhythm ${rhythm.id} user ${userId}: ${result.error}`)
      }
    }
  }

  return { created, skipped, errors }
}

// ─────────────────────────────────────────────────────────────
// generateDelayApprovalTasks
// 来源3：待审批的延期申请
// ─────────────────────────────────────────────────────────────
async function generateDelayApprovalTasks(
  supabase: SupabaseClient,
  targetDate: string
): Promise<TaskGenerationResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []

  const { data: requests, error } = await (supabase.from('delay_requests') as any)
    .select(`
      id, order_id, reason, created_at,
      orders!inner(order_no, customer_name)
    `)
    .eq('status', 'pending')

  if (error) {
    errors.push(`fetchDelayRequests: ${error.message}`)
    return { created, skipped, errors }
  }

  // 延期审批 → 分配给 admin + production_manager
  const approvers = await getUsersByRole(supabase, ['admin', 'production_manager'])

  for (const req of requests || []) {
    const order = req.orders
    const daysWaiting = Math.floor(
      (Date.now() - new Date(req.created_at).getTime()) / (1000 * 60 * 60 * 24)
    )

    for (const userId of approvers) {
      const result = await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: targetDate,
        taskType: 'delay_approval',
        priority: daysWaiting >= 2 ? 1 : 2,
        title: `待审批延期：${order.order_no}${daysWaiting > 0 ? `（等待${daysWaiting}天）` : ''}`,
        description: `客户：${order.customer_name}，原因：${req.reason}`,
        actionUrl: `/orders/${req.order_id}`,
        actionLabel: '审批延期',
        relatedOrderId: req.order_id,
        relatedCustomer: order.customer_name,
        sourceType: 'delay_request',
        sourceId: req.id,
      })

      if (result.ok) {
        if (result.data.created) created++
        else skipped++
      } else {
        errors.push(`delay ${req.id}: ${result.error}`)
      }
    }
  }

  return { created, skipped, errors }
}

// ─────────────────────────────────────────────────────────────
// generateProfitWarningTasks
// 来源4：利润偏低的进行中订单
// ─────────────────────────────────────────────────────────────
async function generateProfitWarningTasks(
  supabase: SupabaseClient,
  targetDate: string
): Promise<TaskGenerationResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []

  const { data: snapshots, error } = await (supabase.from('profit_snapshots') as any)
    .select(`
      id, order_id, gross_margin, margin_status,
      orders!inner(order_no, customer_name, lifecycle_status)
    `)
    .eq('snapshot_type', 'live')
    .in('margin_status', ['critical', 'negative'])
    .not('orders.lifecycle_status', 'in', '("completed","cancelled")')

  if (error) {
    errors.push(`fetchProfitSnapshots: ${error.message}`)
    return { created, skipped, errors }
  }

  const financeUsers = await getUsersByRole(supabase, ['finance', 'admin'])

  for (const snap of snapshots || []) {
    const order = snap.orders
    const marginPct = snap.gross_margin !== null
      ? `${(snap.gross_margin * 100).toFixed(1)}%`
      : '未知'

    const isNegative = snap.margin_status === 'negative'
    const priority: TaskPriority = isNegative ? 1 : 2

    for (const userId of financeUsers) {
      const result = await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: targetDate,
        taskType: 'profit_warning',
        priority,
        title: isNegative
          ? `🚨 亏损订单：${order.order_no}（毛利 ${marginPct}）`
          : `⚠️ 利润偏低：${order.order_no}（毛利 ${marginPct}）`,
        description: `客户：${order.customer_name}`,
        actionUrl: `/orders/${snap.order_id}?tab=finance`,
        actionLabel: '查看财务',
        relatedOrderId: snap.order_id,
        relatedCustomer: order.customer_name,
        sourceType: 'profit_snapshot',
        sourceId: snap.id,
      })

      if (result.ok) {
        if (result.data.created) created++
        else skipped++
      } else {
        errors.push(`snapshot ${snap.id}: ${result.error}`)
      }
    }
  }

  return { created, skipped, errors }
}

// ─────────────────────────────────────────────────────────────
// generateAlertTasks
// 来源5：未读的系统告警 → 转化为 admin 的 daily_task
// ─────────────────────────────────────────────────────────────
async function generateAlertTasks(
  supabase: SupabaseClient,
  targetDate: string
): Promise<TaskGenerationResult> {
  let created = 0
  let skipped = 0
  const errors: string[] = []

  const { data: alerts, error } = await (supabase.from('system_alerts') as any)
    .select('id, alert_type, severity, title, description, entity_id, entity_type')
    .eq('is_resolved', false)
    .eq('is_read', false)
    .eq('severity', 'critical')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    errors.push(`fetchAlerts: ${error.message}`)
    return { created, skipped, errors }
  }

  const adminUsers = await getUsersByRole(supabase, ['admin'])

  for (const alert of alerts || []) {
    for (const userId of adminUsers) {
      const result = await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: targetDate,
        taskType: 'system_alert',
        priority: 1,
        title: alert.title,
        description: alert.description ?? undefined,
        actionUrl: alert.entity_type === 'order' && alert.entity_id
          ? `/orders/${alert.entity_id}`
          : '/dashboard',
        actionLabel: '查看详情',
        relatedOrderId: alert.entity_type === 'order' ? alert.entity_id : undefined,
        relatedCustomer: alert.entity_type === 'customer' ? alert.entity_id : undefined,
        sourceType: 'system_alert',
        sourceId: alert.id,
      })

      if (result.ok) {
        if (result.data.created) created++
        else skipped++
      } else {
        errors.push(`alert ${alert.id}: ${result.error}`)
      }
    }
  }

  return { created, skipped, errors }
}

// ─────────────────────────────────────────────────────────────
// generateDailyTasks
// 主函数：根据 trigger 类型生成对应任务
// ─────────────────────────────────────────────────────────────
export async function generateDailyTasks(
  supabase: SupabaseClient,
  trigger: TaskGenerationTrigger
): Promise<ServiceResult<TaskGenerationResult>> {
  try {
    const targetDate = 'date' in trigger ? trigger.date : todayStr()
    let totalCreated = 0
    let totalSkipped = 0
    const allErrors: string[] = []

    function merge(r: TaskGenerationResult) {
      totalCreated += r.created
      totalSkipped += r.skipped
      allErrors.push(...r.errors)
    }

    if (trigger.trigger === 'daily_cron') {
      // 全量生成：所有来源并行跑
      const [ms, cr, da, pw, al] = await Promise.all([
        generateMilestoneTasks(supabase, targetDate),
        generateCustomerFollowupTasks(supabase, targetDate),
        generateDelayApprovalTasks(supabase, targetDate),
        generateProfitWarningTasks(supabase, targetDate),
        generateAlertTasks(supabase, targetDate),
      ])
      merge(ms); merge(cr); merge(da); merge(pw); merge(al)

    } else if (trigger.trigger === 'milestone_update') {
      // 只刷新该里程碑相关任务
      const r = await generateMilestoneTasks(supabase, targetDate)
      merge(r)

    } else if (trigger.trigger === 'order_created' || trigger.trigger === 'order_updated') {
      // 订单变化 → 刷新里程碑 + 利润预警
      const [ms, pw] = await Promise.all([
        generateMilestoneTasks(supabase, targetDate),
        generateProfitWarningTasks(supabase, targetDate),
      ])
      merge(ms); merge(pw)

    } else if (trigger.trigger === 'delay_request') {
      // 延期申请提交 → 生成审批任务
      const r = await generateDelayApprovalTasks(supabase, targetDate)
      merge(r)

    } else if (trigger.trigger === 'customer_rhythm_update') {
      // 客户节奏更新 → 生成跟进任务
      const r = await generateCustomerFollowupTasks(supabase, targetDate)
      merge(r)
    }

    return ok({
      created: totalCreated,
      skipped: totalSkipped,
      errors: allErrors,
    })
  } catch (e: any) {
    return err(`generateDailyTasks exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// getDailyTasks
// 读取用户今日任务（用于 UI 展示）
// ─────────────────────────────────────────────────────────────
export async function getDailyTasks(
  supabase: SupabaseClient,
  userId: string,
  options?: {
    taskDate?: string
    status?: 'pending' | 'done' | 'snoozed' | 'dismissed'
    taskType?: TaskType
  }
): Promise<ServiceResult<DailyTask[]>> {
  const taskDate = options?.taskDate ?? todayStr()

  let query = (supabase.from('daily_tasks') as any)
    .select('*')
    .eq('assigned_to', userId)
    .eq('task_date', taskDate)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  if (options?.status) {
    query = query.eq('status', options.status)
  } else {
    query = query.in('status', ['pending', 'snoozed'])
  }

  if (options?.taskType) {
    query = query.eq('task_type', options.taskType)
  }

  const { data, error } = await query
  if (error) return err(error.message)
  return ok(data as DailyTask[])
}

// ─────────────────────────────────────────────────────────────
// updateTaskStatus
// 用户操作：完成 / 推迟 / 忽略
// ─────────────────────────────────────────────────────────────
export async function updateTaskStatus(
  supabase: SupabaseClient,
  taskId: string,
  status: 'done' | 'snoozed' | 'dismissed',
  snoozedUntil?: string
): Promise<ServiceResult<void>> {
  const update: Record<string, any> = { status }

  if (status === 'done') {
    update.completed_at = new Date().toISOString()
  }
  if (status === 'snoozed' && snoozedUntil) {
    update.snoozed_until = snoozedUntil
  }

  const { error } = await (supabase.from('daily_tasks') as any)
    .update(update)
    .eq('id', taskId)

  if (error) return err(error.message)
  return ok(undefined)
}

// ─────────────────────────────────────────────────────────────
// getTasksSummary
// Dashboard 汇总：今日任务统计（按优先级、类型分组）
// ─────────────────────────────────────────────────────────────
export async function getTasksSummary(
  supabase: SupabaseClient,
  userId: string,
  taskDate?: string
): Promise<ServiceResult<{
  total: number
  urgent: number       // priority=1
  byType: Record<TaskType, number>
}>> {
  const date = taskDate ?? todayStr()

  const { data, error } = await (supabase.from('daily_tasks') as any)
    .select('task_type, priority')
    .eq('assigned_to', userId)
    .eq('task_date', date)
    .in('status', ['pending', 'snoozed'])

  if (error) return err(error.message)

  const tasks = data || []
  const total = tasks.length
  const urgent = tasks.filter((t: any) => t.priority === 1).length

  const byType: Record<string, number> = {}
  for (const t of tasks) {
    byType[t.task_type] = (byType[t.task_type] ?? 0) + 1
  }

  return ok({ total, urgent, byType: byType as Record<TaskType, number> })
}
