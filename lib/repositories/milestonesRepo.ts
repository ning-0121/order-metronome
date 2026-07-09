/**
 * Milestones Repository
 * 数据契约层：所有对 milestones 表的写入必须通过此 repository
 * 
 * 职责：
 * 1. 字段白名单过滤
 * 2. 状态映射和校验
 * 3. 状态机转换校验
 * 4. 事件日志记录
 * 5. 默认值填充
 */

import { createClient } from '@/lib/supabase/server';
import { canModifyMilestones, getStatusTransitionError, isBlockedStatus, isDoneStatus, isValidStatusTransition, normalizeMilestoneStatus, type MilestoneStatus, type OrderLifecycleStatus } from '@/lib/domain/types';
import { formatBlockedReasonToNotes, appendToNotes } from '@/lib/domain/milestone-helpers';
import { normalizeRoleToDb } from '@/lib/domain/roles';
// DB profile-based role check is done inline (multi-role aware)

/**
 * 将中文状态映射为数据库枚举值（英文）
 * 数据库使用枚举类型 milestone_status: 'pending', 'in_progress', 'done', 'blocked', 'overdue'
 */
function mapStatusToDbEnum(status: MilestoneStatus | string): string {
  const statusMap: Record<string, string> = {
    '未开始': 'pending',
    '进行中': 'in_progress',
    '已完成': 'done',
    '阻塞': 'blocked',
    '卡住': 'blocked', // 兼容旧代码
    'overdue': 'overdue',
    // 兼容英文状态
    'pending': 'pending',
    'in_progress': 'in_progress',
    'done': 'done',
    'blocked': 'blocked',
  };
  
  const normalized = normalizeMilestoneStatus(status);
  return statusMap[normalized] || 'pending';
}

/**
 * 将数据库枚举值（英文）映射为中文状态
 */
function mapDbEnumToStatus(dbStatus: string): MilestoneStatus {
  const enumMap: Record<string, MilestoneStatus> = {
    'pending': '未开始',
    'in_progress': '进行中',
    'done': '已完成',
    'blocked': '阻塞',
    'overdue': '阻塞', // overdue 映射为阻塞
  };
  
  return enumMap[dbStatus] || '未开始';
}

// 白名单字段（与数据库表结构一致）
const INSERT_WHITELIST = [
  'order_id',
  'step_key',
  'name',
  'owner_role',
  'owner_user_id',
  'planned_at',
  'due_at',
  'actual_at',
  'status',
  'notes',
  'is_critical',
  'evidence_required',
] as const;

const UPDATE_WHITELIST = [
  'step_key',
  'name',
  'owner_role',
  'owner_user_id',
  'planned_at',
  'due_at',
  'actual_at',
  'status',
  'notes',
  'is_critical',
  'evidence_required',
] as const;

const UPDATE_BLACKLIST = ['id', 'order_id', 'created_at', 'updated_at'];

/**
 * 清洗 payload：移除未知字段，处理状态映射
 */
function sanitizePayload(
  input: Record<string, any>,
  mode: 'insert' | 'update'
): { payload: Record<string, any>; removedFields: string[] } {
  const whitelist = mode === 'insert' ? INSERT_WHITELIST : UPDATE_WHITELIST;
  const removedFields: string[] = [];
  const payload: Record<string, any> = {};

  // 状态映射：先标准化为中文，然后映射为数据库枚举值（英文）
  if (input.status !== undefined) {
    const normalizedStatus = normalizeMilestoneStatus(input.status);
    // 对于数据库插入/更新，需要转换为英文枚举值
    payload.status = mapStatusToDbEnum(normalizedStatus);
  }

  // 处理 blocked_reason/blockedReason -> notes 映射（兼容旧代码）
  const blockedReason = input.blocked_reason || input.blockedReason;
  if (blockedReason !== undefined) {
    // 将 blocked_reason 格式化为 notes
    payload.notes = formatBlockedReasonToNotes(
      String(blockedReason),
      input.notes,
      false // 不追加，直接替换或设置
    );
    
    if (input.blocked_reason !== undefined) removedFields.push('blocked_reason');
    if (input.blockedReason !== undefined) removedFields.push('blockedReason');
  } else if (input.notes !== undefined) {
    // 处理 notes：空字符串转 null
    payload.notes = input.notes ? String(input.notes).trim() : null;
  }

  // 白名单过滤
  for (const key of whitelist) {
    if (key === 'status' || key === 'notes') {
      // status 和 notes 已在上面处理过
      continue;
    }
    
    if (key === 'owner_role') {
      // ⚠️ 角色值必须通过 normalizeRoleToDb 映射
      if (input.owner_role !== undefined) {
        payload.owner_role = normalizeRoleToDb(input.owner_role);
      }
      continue;
    }
    
    if (key in input) {
      payload[key] = input[key];
    }
  }

  // 收集所有被移除的未知字段
  const processedKeys = new Set<string>(['status', 'notes', 'blocked_reason', 'blockedReason']);
  
  for (const key in input) {
    if (processedKeys.has(key)) continue;
    
    if (whitelist.includes(key as any)) {
      continue;
    }
    
    if (mode === 'update' && UPDATE_BLACKLIST.includes(key)) {
      if (!removedFields.includes(key)) {
        removedFields.push(key);
      }
      continue;
    }
    
    if (!removedFields.includes(key)) {
      removedFields.push(key);
    }
  }

  // Dev 环境警告
  if (removedFields.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[MilestonesRepo] Removed unknown fields:',
      removedFields.join(', '),
      '\nPayload keys:',
      Object.keys(input).join(', ')
    );
  }

  return { payload, removedFields };
}

/**
 * 记录里程碑事件日志
 */
async function logMilestoneEvent(
  supabase: any,
  milestoneId: string,
  orderId: string,
  action: string,
  fromStatus: MilestoneStatus | null,
  toStatus: MilestoneStatus | null,
  note: string | null = null
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    console.warn('[MilestonesRepo] Cannot log event: user not authenticated');
    return;
  }

  try {
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: milestoneId,
      order_id: orderId,
      actor_user_id: user.id,
      action,
      from_status: fromStatus,
      to_status: toStatus,
      note: note || null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // 日志失败不应该影响主流程，但要在 dev 环境警告
    if (process.env.NODE_ENV === 'development') {
      console.error('[MilestonesRepo] Failed to log event:', error);
    }
  }
}

/**
 * 创建里程碑（统一入口）
 */
export async function createMilestone(
  payload: Record<string, any>
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { payload: sanitized } = sanitizePayload(payload, 'insert');
  
  // 必填字段验证
  if (!sanitized.order_id) {
    return { error: 'order_id is required' };
  }
  
  // 默认值填充：映射为数据库枚举值
  if (!sanitized.status) {
    sanitized.status = 'pending'; // 数据库枚举值
  }
  
  if (sanitized.notes === undefined) {
    sanitized.notes = null;
  }
  
  const { data, error } = await (supabase
    .from('milestones') as any)
    .insert(sanitized)
    .select()
    .single();
  
  if (error) {
    return { error: error.message };
  }
  
  // 记录创建日志（将数据库枚举值转换回中文状态）
  await logMilestoneEvent(
    supabase,
    data.id,
    sanitized.order_id,
    'create',
    null,
    mapDbEnumToStatus(sanitized.status),
    '里程碑已创建'
  );
  
  return { data };
}

/**
 * 批量创建里程碑（统一入口）
 */
export async function createMilestones(
  payloads: Record<string, any>[]
): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  
  const sanitizedPayloads = payloads.map(p => {
    const { payload } = sanitizePayload(p, 'insert');
    
    // 默认值填充：映射为数据库枚举值
    // sanitizePayload 已经将状态映射为数据库枚举值了
    if (!payload.status) {
      payload.status = 'pending'; // 数据库枚举值
    }
    
    if (payload.notes === undefined) {
      payload.notes = null;
    }
    
    // 调试：确保状态是数据库枚举值
    if (process.env.NODE_ENV === 'development') {
      console.log('[MilestonesRepo] Creating milestone with status:', payload.status, 'from input:', p.status);
    }
    
    return payload;
  });
  
  // 验证所有 payload 都有 order_id
  for (const p of sanitizedPayloads) {
    if (!p.order_id) {
      return { error: 'order_id is required for all milestones' };
    }
  }
  
  const { data, error } = await (supabase
    .from('milestones') as any)
    .insert(sanitizedPayloads)
    .select();
  
  if (error) {
    return { error: error.message };
  }
  
  // 记录批量创建日志（将数据库枚举值转换为中文）
  for (const milestone of data || []) {
    await logMilestoneEvent(
      supabase,
      milestone.id,
      milestone.order_id,
      'create',
      null,
      mapDbEnumToStatus(milestone.status),
      '里程碑已创建'
    );
  }
  
  return { data: data || [] };
}

/**
 * 检查 Gate 依赖是否满足（required Gate 必须已完成）
 */
async function checkGateDependencies(
  supabase: any,
  orderId: string,
  milestone: any
): Promise<{ canProceed: boolean; reason?: string }> {
  // 如果 milestone 没有 depends_on 字段，跳过检查
  if (!milestone.depends_on || !Array.isArray(milestone.depends_on) || milestone.depends_on.length === 0) {
    return { canProceed: true };
  }

  // 检查所有依赖的 required Gate 是否已完成
  const { data: dependentMilestones } = await (supabase
    .from('milestones') as any)
    .select('step_key, status, required')
    .eq('order_id', orderId)
    .in('step_key', milestone.depends_on);

  if (!dependentMilestones || dependentMilestones.length === 0) {
    return { canProceed: true }; // 依赖的 Gate 不存在，允许继续
  }

  // 检查 required 依赖是否已完成
  for (const dep of dependentMilestones) {
    // 只检查 required 的依赖
    if (dep.required && !isDoneStatus(dep.status)) {
      // 获取依赖 Gate 的名称
      const { data: depMilestone } = await (supabase
        .from('milestones') as any)
        .select('name')
        .eq('order_id', orderId)
        .eq('step_key', dep.step_key)
        .single();
      
      return {
        canProceed: false,
        reason: `依赖的强制控制点"${depMilestone?.name || dep.step_key}"尚未完成，无法开始此控制点`,
      };
    }
  }

  return { canProceed: true };
}

/**
 * 更新里程碑状态（带状态机校验和依赖检查）
 * 
 * ⚠️ 强约束：
 * 1. 只有'已生效'和'执行中'状态的订单才允许里程碑状态变更
 * 2. required Gate 未通过前，后续 Gate 不可进入"进行中"
 */
export async function transitionMilestoneStatus(
  milestoneId: string,
  nextStatus: string | MilestoneStatus,
  note?: string | null
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  // 获取当前里程碑
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || 'Milestone not found' };
  }
  
  // ⚠️ 封死入口：检查订单是否存在
  const { data: order, error: orderError } = await (supabase
    .from('orders') as any)
    .select('id')
    .eq('id', milestone.order_id)
    .single();
  
  if (orderError || !order) {
    return { error: orderError?.message || 'Order not found' };
  }
  
  // ⚠️ 权限检查：admin / assigned user / owner_role 匹配（多角色）
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { error: '请先登录' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUser = userRoles.includes('admin');
  const isAssignedUser = milestone.owner_user_id === user.id;
  const roleMatches = milestone.owner_role && userRoles.some(
    (r: string) => r.toLowerCase() === (milestone.owner_role as string).toLowerCase()
      || (milestone.owner_role === 'qc' && (r === 'qc' || r === 'quality'))
  );
  if (!isAdminUser && !isAssignedUser && !roleMatches) {
    return { error: '无权操作：只有管理员、负责人或对应角色可以修改此节点' };
  }

  // 将数据库枚举值转换为中文状态进行比较
  const currentStatus = mapDbEnumToStatus(milestone.status);
  const normalizedNextStatus = normalizeMilestoneStatus(nextStatus);
  
  // ⚠️ Gate 依赖检查：如果要进入"进行中"状态，检查依赖的 required Gate 是否已完成
  // 例外：从「阻塞」恢复到「进行中」是解锁动作，不应被 Gate 依赖挡 — 用户之前
  // 能把它 block 说明节点本来就是活跃的，解锁只是恢复之前的状态，不是新启动。
  // 2026-05-19：之前没区分这两个场景，导致 markMilestoneUnblocked 在有上游
  // 强制 Gate 未完成时永久失败 → UI 显示锁住、无法处理。
  if (normalizedNextStatus === '进行中' && currentStatus !== '阻塞') {
    const depCheck = await checkGateDependencies(supabase, milestone.order_id, milestone);
    if (!depCheck.canProceed) {
      return { error: depCheck.reason || '依赖的控制点尚未完成' };
    }
  }
  
  // 状态机校验
  if (!isValidStatusTransition(currentStatus, normalizedNextStatus)) {
    const errorMsg = getStatusTransitionError(currentStatus, normalizedNextStatus);
    
    // Dev 环境抛错，Prod 环境返回可读错误
    if (process.env.NODE_ENV === 'development') {
      console.error('[MilestonesRepo] Invalid status transition:', {
        milestoneId,
        from: currentStatus,
        to: normalizedNextStatus,
        error: errorMsg,
      });
    }
    
    return { error: errorMsg };
  }
  
  // 处理 notes
  let updatedNotes = milestone.notes;

  if (normalizedNextStatus === '阻塞' && note) {
    // 阻塞状态：格式化原因到 notes
    updatedNotes = formatBlockedReasonToNotes(note, milestone.notes, false);
  } else if (note) {
    // 从「阻塞」转出（解锁 / 完成）时，先剥掉 notes 里残留的「卡住原因：xxx」首行，
    // 再把新 note 追加进去。否则解锁后 notes 还挂着卡住原因，UI 会继续展示
    // 「🚧 阻塞说明」等历史信息让用户以为没解锁成功。2026-05-19。
    let baseNotes = milestone.notes || '';
    if (currentStatus === '阻塞') {
      // formatBlockedReasonToNotes 的格式是「卡住原因：XXX」起头，可能后面跟 \n\n + 其他
      // 剥掉首行的卡住原因
      baseNotes = baseNotes.replace(/^卡住原因：[^\n]*(\n\n?|$)/, '').trim();
    }
    updatedNotes = appendToNotes(baseNotes || null, note, true);
  }
  
  // 更新状态：将中文状态转换为数据库枚举值
  const updatePayload: Record<string, any> = {
    status: mapStatusToDbEnum(normalizedNextStatus),
    notes: updatedNotes,
  };
  // KPI: 记录开始时间（首次进入进行中）
  if (normalizedNextStatus === '进行中' && !milestone.started_at) {
    updatePayload.started_at = new Date().toISOString();
  }
  // KPI: 记录完成时间
  if (normalizedNextStatus === '已完成') {
    updatePayload.completed_at = new Date().toISOString();
  }

  const { data: updated, error: updateError } = await (supabase
    .from('milestones') as any)
    .update(updatePayload)
    .eq('id', milestoneId)
    .select()
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  // 记录状态转换日志（使用中文状态）
  await logMilestoneEvent(
    supabase,
    milestoneId,
    milestone.order_id,
    'status_transition',
    currentStatus,
    normalizedNextStatus,
    note || `状态从"${currentStatus}"转换为"${normalizedNextStatus}"`
  );

  // ── Runtime Hook: 状态转换（进行中/阻塞/解除阻塞等）→ 异步重算 confidence。
  // 与 updateMilestone 内钩子同口径。此函数走独立 update 分支，之前不触发重算，
  // 导致标进行中/解除阻塞后交付置信度风险卡不刷新。fire-and-forget，永不阻塞主链路。
  fireRuntimeRecompute(milestone.order_id, {
    type: 'milestone_status_changed',
    source: `milestone:${milestoneId}`,
    severity: isBlockedStatus(updatePayload.status) ? 'warning' : 'info',
    payload: {
      milestone_id: milestoneId,
      new_status: updatePayload.status,
      old_status: milestone.status,
    },
  });

  return { data: updated };
}

/**
 * 更新里程碑（统一入口，不包含状态转换）
 * 
 * ⚠️ 强约束：只有'已生效'和'执行中'状态的订单才允许里程碑变更
 */
export async function updateMilestone(
  id: string,
  patch: Record<string, any>
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  // 获取当前里程碑（用于状态转换校验和订单状态检查）
  const { data: currentMilestone, error: getMilestoneError } = await (supabase
    .from('milestones') as any)
    .select('status, order_id, owner_role, step_key, name')
    .eq('id', id)
    .single();
  
  if (getMilestoneError || !currentMilestone) {
    return { error: getMilestoneError?.message || 'Milestone not found' };
  }
  
  // ⚠️ 权限检查：admin / assigned user / owner_role 匹配（多角色）
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { error: '请先登录' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUser = userRoles.includes('admin');
  const isAssignedUser = currentMilestone.owner_user_id === user.id;
  const roleMatches = currentMilestone.owner_role && userRoles.some(
    (r: string) => r.toLowerCase() === (currentMilestone.owner_role as string).toLowerCase()
      || (currentMilestone.owner_role === 'qc' && (r === 'qc' || r === 'quality'))
  );
  if (!isAdminUser && !isAssignedUser && !roleMatches) {
    return { error: '无权操作：只有管理员、负责人或对应角色可以修改此节点' };
  }

  // ⚠️ 封死入口：检查订单是否存在
  const { data: order, error: orderError } = await (supabase
    .from('orders') as any)
    .select('id')
    .eq('id', currentMilestone.order_id)
    .single();
  
  if (orderError || !order) {
    return { error: orderError?.message || 'Order not found' };
  }
  
  // 订单存在即可修改里程碑
  
  const { payload: sanitized } = sanitizePayload(patch, 'update');
  
  // 如果更新了状态，需要校验状态转换
  if (sanitized.status && currentMilestone) {
    // 将数据库枚举值转换为中文状态进行比较
    const currentStatus = mapDbEnumToStatus(currentMilestone.status);
    const nextStatus = mapDbEnumToStatus(sanitized.status);
    
    if (!isValidStatusTransition(currentStatus, nextStatus)) {
      const errorMsg = getStatusTransitionError(currentStatus, nextStatus);
      
      if (process.env.NODE_ENV === 'development') {
        console.error('[MilestonesRepo] Invalid status transition in update:', {
          milestoneId: id,
          from: currentStatus,
          to: nextStatus,
          error: errorMsg,
        });
      }
      
      return { error: errorMsg };
    }
    
    // 记录状态转换日志（使用中文状态）
    await logMilestoneEvent(
      supabase,
      id,
      currentMilestone.order_id || '',
      'status_transition',
      currentStatus,
      nextStatus,
      sanitized.notes || null
    );
  }
  
  // 如果更新了状态，需要将中文状态转换回数据库枚举值
  if (sanitized.status) {
    sanitized.status = mapStatusToDbEnum(sanitized.status);
  }
  
  // 不允许更新空对象
  if (Object.keys(sanitized).length === 0) {
    return { error: 'No valid fields to update' };
  }
  
  const { data, error } = await (supabase
    .from('milestones') as any)
    .update(sanitized)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return { error: error.message };
  }

  // 记录更新日志（非状态转换）
  if (!sanitized.status && currentMilestone) {
    const currentStatus = mapDbEnumToStatus(currentMilestone.status);
    await logMilestoneEvent(
      supabase,
      id,
      currentMilestone.order_id || '',
      'update',
      currentStatus,
      currentStatus,
      '里程碑信息已更新'
    );
  }

  // ── Runtime Hook 1: milestone 状态/截止变更 → 异步重算 confidence
  // fire-and-forget，永不阻塞主链路；recompute 内部已 catch 所有错
  if (currentMilestone?.order_id && (sanitized.status || sanitized.due_at || sanitized.planned_at)) {
    fireRuntimeRecompute(currentMilestone.order_id, {
      type: 'milestone_status_changed',
      source: `milestone:${id}`,
      severity: isBlockedStatus(sanitized.status) ? 'warning' : 'info',
      payload: {
        milestone_id: id,
        new_status: sanitized.status,
        new_due_at: sanitized.due_at,
        old_status: currentMilestone.status,
      },
    });
  }

  // ── H3:财务确认节点(owner_role='finance',如财务审核/核准出运/收款)推进到 in_progress(待财务确认)
  //    → 发 milestone.requested 给财务系统审批队列(财务批准回传 approval_type='milestone')。fire-and-forget。
  const becameInProgress = sanitized.status === 'in_progress' && currentMilestone?.status !== 'in_progress';
  if (currentMilestone?.order_id && becameInProgress && currentMilestone?.owner_role === 'finance') {
    void (async () => {
      try {
        const { createServiceRoleClient } = await import('@/lib/supabase/server');
        const svc = createServiceRoleClient();
        const { data: ord } = await (svc.from('orders') as any).select('order_no, customer_name, total_amount, currency').eq('id', currentMilestone.order_id).maybeSingle();
        const { syncMilestoneRequestToFinance } = await import('@/lib/integration/finance-sync');
        const label = currentMilestone.name || currentMilestone.step_key || '里程碑';
        await syncMilestoneRequestToFinance({
          id, order_no: (ord as any)?.order_no ?? null, customer_name: (ord as any)?.customer_name ?? null,
          requester_name: null, summary: `里程碑待财务确认:${label}`,
          // 结构化:审批环节 + 订单金额(收款/PO确认等财务据此对本次金额;财务按 step_key 高亮对应决算桶)
          detail: {
            step_key: currentMilestone.step_key ?? null,
            amount: (ord as any)?.total_amount ?? null,
            currency: (ord as any)?.currency ?? null,
          },
          created_at: new Date().toISOString(),
        });
      } catch (e: any) { console.warn('[milestone-hook] milestone.requested 发送失败(不阻断):', e?.message); }
    })();
  }

  return { data };
}

/**
 * Fire-and-forget runtime confidence 重算
 * 动态导入避免 server action 循环依赖，并保证主链路绝不被阻塞或失败
 */
export function fireRuntimeRecompute(orderId: string, event: any): void {
  void (async () => {
    try {
      const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
      const r = await recomputeDeliveryConfidence(orderId, event);
      if (!r.ok && !r.skipped) {
        console.warn('[runtime-hook]', 'milestone hook recompute returned error:', r.error);
      }
    } catch (e: any) {
      console.error('[runtime-hook]', 'milestone hook crashed:', e?.message);
    }
  })();
}

/**
 * 批量更新里程碑（统一入口）
 */
export async function updateMilestones(
  updates: Array<{ id: string; patch: Record<string, any> }>
): Promise<{ data?: any[]; error?: string }> {
  const results: any[] = [];
  
  for (const { id, patch } of updates) {
    const result = await updateMilestone(id, patch);
    if (result.error) {
      return { error: `Failed to update milestone ${id}: ${result.error}` };
    }
    if (result.data) {
      results.push(result.data);
    }
  }
  
  return { data: results };
}

