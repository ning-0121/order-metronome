/**
 * Milestones 数据清洗和映射层
 * 统一入口：所有对 milestones 的写入操作必须通过此模块
 */

import { createClient } from '@/lib/supabase/server';

// 状态映射：英文 -> 中文
const STATUS_MAP: Record<string, string> = {
  'not_started': '未开始',
  'in_progress': '进行中',
  'blocked': '卡住',
  'done': '已完成',
};

// 白名单字段（与数据库表结构一致）
const INSERT_WHITELIST = [
  'order_id',
  'step_key',
  'name',
  'owner_role',
  'owner_user_id',
  'planned_at',
  'due_at',
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
  'status',
  'notes',
  'is_critical',
  'evidence_required',
] as const;

// 禁止在 update 中修改的字段
const UPDATE_BLACKLIST = ['id', 'order_id', 'created_at', 'updated_at'];

/**
 * 映射状态值：旧英文状态 -> 新中文状态
 */
export function mapMilestoneStatus(status: string | null | undefined): string {
  if (!status) return '未开始';
  
  const normalized = status.toLowerCase().trim();
  
  // 如果已经是中文状态，直接返回
  if (STATUS_MAP[normalized]) {
    return STATUS_MAP[normalized];
  }
  
  // 如果已经是中文，直接返回
  const chineseStatuses = Object.values(STATUS_MAP);
  if (chineseStatuses.includes(status)) {
    return status;
  }
  
  // 默认返回未开始
  return '未开始';
}

/**
 * 清洗 payload：移除未知字段，处理 blocked_reason 映射
 */
export function sanitizeMilestonePayload(
  input: Record<string, any>,
  mode: 'insert' | 'update'
): { payload: Record<string, any>; removedFields: string[] } {
  const whitelist = mode === 'insert' ? INSERT_WHITELIST : UPDATE_WHITELIST;
  const removedFields: string[] = [];
  
  // 创建清洗后的 payload
  const payload: Record<string, any> = {};
  
  // 状态映射
  if (input.status !== undefined) {
    payload.status = mapMilestoneStatus(input.status);
  }
  
  // 处理 blocked_reason/blockedReason -> notes 映射
  const blockedReason = input.blocked_reason || input.blockedReason;
  if (blockedReason !== undefined) {
    // 如果 notes 已有内容，优先保留 notes；否则使用 blocked_reason
    if (!input.notes || !input.notes.trim()) {
      payload.notes = blockedReason ? String(blockedReason).trim() : null;
    } else {
      // notes 已有内容，保留原 notes
      payload.notes = input.notes.trim() || null;
    }
    
    // 标记 blocked_reason 字段为已移除
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
    
    if (key in input) {
      payload[key] = input[key];
    }
  }
  
  // 收集所有被移除的未知字段（包括黑名单字段）
  const processedKeys = new Set<string>(['status', 'notes', 'blocked_reason', 'blockedReason']);
  
  for (const key in input) {
    // 跳过已处理的字段
    if (processedKeys.has(key)) continue;
    
    // 检查是否在白名单中
    if (whitelist.includes(key as any)) {
      // 白名单字段已处理，跳过
      continue;
    }
    
    // 检查是否在黑名单中（仅 update 模式）
    if (mode === 'update' && UPDATE_BLACKLIST.includes(key)) {
      if (!removedFields.includes(key)) {
        removedFields.push(key);
      }
      continue;
    }
    
    // 未知字段
    if (!removedFields.includes(key)) {
      removedFields.push(key);
    }
  }
  
  // Dev 环境警告
  if (removedFields.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[Milestone Sanitizer] Removed unknown fields:',
      removedFields.join(', '),
      '\nPayload keys:',
      Object.keys(input).join(', ')
    );
  }
  
  return { payload, removedFields };
}

/**
 * 创建里程碑（统一入口）
 */
export async function createMilestone(
  payload: Record<string, any>
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { payload: sanitized, removedFields } = sanitizeMilestonePayload(payload, 'insert');
  
  // 必填字段验证
  if (!sanitized.order_id) {
    return { error: 'order_id is required' };
  }
  
  const { data, error } = await (supabase
    .from('milestones') as any)
    .insert(sanitized)
    .select()
    .single();
  
  if (error) {
    return { error: error.message };
  }
  
  return { data };
}

/**
 * 批量创建里程碑（统一入口）
 */
export async function createMilestones(
  payloads: Record<string, any>[]
): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  
  const sanitizedPayloads = payloads.map(p => sanitizeMilestonePayload(p, 'insert').payload);
  
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
  
  return { data: data || [] };
}

/**
 * 更新里程碑（统一入口）
 */
export async function updateMilestone(
  id: string,
  patch: Record<string, any>
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { payload: sanitized, removedFields } = sanitizeMilestonePayload(patch, 'update');
  
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
  
  return { data };
}

/**
 * 批量更新里程碑（统一入口）
 */
export async function updateMilestones(
  updates: Array<{ id: string; patch: Record<string, any> }>
): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  
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

/**
 * Upsert 里程碑（统一入口）
 */
export async function upsertMilestones(
  payloads: Record<string, any>[]
): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  
  const sanitizedPayloads = payloads.map(p => sanitizeMilestonePayload(p, 'insert').payload);
  
  const { data, error } = await (supabase
    .from('milestones') as any)
    .upsert(sanitizedPayloads, { onConflict: 'id' })
    .select();
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: data || [] };
}
