/**
 * Orders Repository
 * 数据契约层：所有对 orders 表的写入必须通过此 repository
 */

import { createClient } from '@/lib/supabase/server';
import {
  transitionOrderLifecycle,
  type OrderLifecycleStatus,
} from '@/lib/domain/types';
import { createMilestone, transitionMilestoneStatus } from './milestonesRepo';

// ⚠️ 系统级约束：order_no 只能由系统生成，禁止外部传入
// 白名单字段（与数据库表结构一致）
// 注意：order_no 不在白名单中，由系统自动生成
const INSERT_WHITELIST = [
  'customer_name',
  'incoterm',
  'etd',
  'warehouse_due_date',
  'order_type',
  'packaging_type',
  'created_by',
  'notes',
] as const;

const UPDATE_WHITELIST = [
  'customer_name',
  'incoterm',
  'etd',
  'warehouse_due_date',
  'order_type',
  'packaging_type',
  'notes',
] as const;

// ⚠️ 系统级约束：order_no 一旦生成，永不修改
const UPDATE_BLACKLIST = ['id', 'order_no', 'created_by', 'created_at', 'updated_at'];

/**
 * 清洗 payload：移除未知字段
 * ⚠️ 系统级约束：order_no 必须由系统生成，外部传入的 order_no 会被直接丢弃
 */
function sanitizePayload(
  input: Record<string, any>,
  mode: 'insert' | 'update'
): { payload: Record<string, any>; removedFields: string[] } {
  const whitelist = mode === 'insert' ? INSERT_WHITELIST : UPDATE_WHITELIST;
  const removedFields: string[] = [];
  const payload: Record<string, any> = {};

  // ⚠️ 系统级约束：禁止外部传入 order_no（insert 模式）
  if (mode === 'insert' && 'order_no' in input) {
    removedFields.push('order_no');
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        '[OrdersRepo] order_no is system-generated. External order_no was removed.'
      );
    }
  }

  // 白名单过滤
  for (const key of whitelist) {
    if (key in input) {
      payload[key] = input[key];
    }
  }

  // 收集所有被移除的未知字段
  for (const key in input) {
    if (key === 'order_no' && mode === 'insert') {
      // 已在上面处理
      continue;
    }
    
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
      '[OrdersRepo] Removed unknown fields:',
      removedFields.join(', '),
      '\nPayload keys:',
      Object.keys(input).join(', ')
    );
  }

  return { payload, removedFields };
}

/**
 * ⚠️ 系统级函数：安全生成订单号
 * 
 * 订单号格式：QM-YYYYMMDD-XXX
 * 示例：QM-20260121-001, QM-20260121-012
 * 
 * 要求：
 * - 在数据库事务中执行（使用 PostgreSQL 函数确保原子性）
 * - 对 order_sequences 当天行加锁（防并发）
 * - 若当天无记录 → insert (current_seq = 1)
 * - 若已有记录 → current_seq + 1
 * - 订单号一旦生成，永不回收、不修改
 * 
 * 禁止：
 * - 使用 JS 时间做唯一性
 * - 使用 UUID
 * - 使用 orders 表 count
 * - 使用前端生成
 * 
 * 实现方式：
 * 使用 PostgreSQL 函数 `generate_order_sequence()` 确保原子性和并发安全
 */
export async function generateOrderNo(): Promise<{ orderNo?: string; error?: string }> {
  const supabase = await createClient();
  
  const today = new Date();
  const dateKey = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const dateKeyFormatted = dateKey.replace(/-/g, ''); // YYYYMMDD
  
  try {
    // ⚠️ 使用 PostgreSQL 函数确保事务安全和并发安全
    // 调用 generate_order_sequence(date) 函数
    const { data, error } = await (supabase.rpc as any)('generate_order_sequence', {
      _date_key: dateKey,
    });
    
    if (error) {
      return { error: `Failed to generate order sequence: ${error.message}` };
    }
    
    if (data === null || data === undefined) {
      return { error: 'Failed to generate order sequence: function returned null' };
    }
    
    const nextSeq = parseInt(data, 10);
    if (isNaN(nextSeq) || nextSeq < 1) {
      return { error: `Invalid sequence number: ${data}` };
    }
    
    // 生成订单号：QM-YYYYMMDD-XXX（XXX 为 3 位数字，不足补零）
    const seqStr = String(nextSeq).padStart(3, '0');
    const orderNo = `QM-${dateKeyFormatted}-${seqStr}`;
    
    return { orderNo };
  } catch (error: any) {
    return { error: `Unexpected error generating order number: ${error.message}` };
  }
}

/**
 * ⚠️ 系统级函数：创建订单（统一入口）
 * 
 * 流程：
 * 1. 先生成 order_no（如果未提供）
 * 2. 再创建 orders 记录
 * 3. order_no 必须在 orders 表中写入
 * 
 * 约束：
 * - order_no 只能由系统生成（通过 generateOrderNo）
 * - 禁止外部传入 order_no（字段白名单已拦截）
 * - 如果 payload 包含 order_no，会被直接丢弃，不报错
 */
export async function createOrder(
  payload: Record<string, any>,
  orderNo?: string // 可选：如果已预生成订单号，直接使用
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  // ⚠️ 系统级约束：order_no 必须由系统生成
  // 如果未提供 orderNo 参数，则生成新的订单号
  let finalOrderNo: string;
  
  if (orderNo) {
    // 使用预生成的订单号（来自向导预生成）
    finalOrderNo = orderNo;
  } else {
    // 生成新的订单号
    const { orderNo: generated, error: genError } = await generateOrderNo();
    if (genError || !generated) {
      return { error: genError || 'Failed to generate order number' };
    }
    finalOrderNo = generated;
  }
  
  const { payload: sanitized } = sanitizePayload(payload, 'insert');
  
  // ⚠️ 系统级约束：order_no 必须写入 orders 表
  sanitized.order_no = finalOrderNo;
  
  // 必填字段验证
  if (!sanitized.customer_name) {
    return { error: 'customer_name is required' };
  }
  if (!sanitized.incoterm) {
    return { error: 'incoterm is required' };
  }
  if (!sanitized.order_type) {
    return { error: 'order_type is required' };
  }
  if (!sanitized.packaging_type) {
    return { error: 'packaging_type is required' };
  }
  
  // Incoterm 特定验证
  if (sanitized.incoterm === 'FOB' && !sanitized.etd) {
    return { error: 'ETD is required for FOB orders' };
  }
  if (sanitized.incoterm === 'DDP' && !sanitized.warehouse_due_date) {
    return { error: 'Warehouse Due Date is required for DDP orders' };
  }
  
  // 默认值填充
  if (sanitized.notes === undefined) {
    sanitized.notes = null;
  }
  
  const { data, error } = await (supabase
    .from('orders') as any)
    .insert(sanitized)
    .select()
    .single();
  
  if (error) {
    return { error: error.message };
  }
  
  return { data };
}

/**
 * ⚠️ 系统级函数：更新订单（统一入口）
 * 
 * 约束：
 * - order_no 一旦生成，永不修改（UPDATE_BLACKLIST 已包含）
 * - 任何尝试更新 order_no 的请求都会被拦截
 */
export async function updateOrder(
  id: string,
  patch: Record<string, any>
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  // ⚠️ 系统级约束：禁止更新 order_no
  if ('order_no' in patch) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[OrdersRepo] order_no cannot be updated. It was removed from update payload.');
    }
  }
  
  const { payload: sanitized } = sanitizePayload(patch, 'update');
  
  // 不允许更新空对象
  if (Object.keys(sanitized).length === 0) {
    return { error: 'No valid fields to update' };
  }
  
  // Incoterm 特定验证（如果更新了 incoterm）
  if (sanitized.incoterm === 'FOB' && !sanitized.etd) {
    // 需要检查现有订单的 etd
    const { data: current } = await (supabase
      .from('orders') as any)
      .select('etd')
      .eq('id', id)
      .single();
    
    if (!current?.etd) {
      return { error: 'ETD is required for FOB orders' };
    }
  }
  
  if (sanitized.incoterm === 'DDP' && !sanitized.warehouse_due_date) {
    const { data: current } = await (supabase
      .from('orders') as any)
      .select('warehouse_due_date')
      .eq('id', id)
      .single();
    
    if (!current?.warehouse_due_date) {
      return { error: 'Warehouse Due Date is required for DDP orders' };
    }
  }
  
  const { data, error } = await (supabase
    .from('orders') as any)
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
 * ⚠️ 系统级函数：删除订单（统一入口）
 * 
 * 注意：
 * - 删除订单 ≠ 删除记录
 * - 订单号一旦生成，永不回收、不重用
 * - 建议：只允许逻辑删除（添加 deleted_at 字段），不允许物理删除
 * 
 * 当前实现：物理删除（未来可改为逻辑删除）
 */
export async function deleteOrder(
  id: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  
  // ⚠️ 警告：物理删除会永久删除订单记录
  // 订单号不会回收，但订单记录会被删除
  // 建议未来改为逻辑删除（添加 deleted_at 字段）
  const { error } = await (supabase
    .from('orders') as any)
    .delete()
    .eq('id', id);
  
  if (error) {
    return { error: error.message };
  }
  
  return {};
}

// =========================
// 订单生命周期管理（V1.6）
// =========================

/**
 * 记录订单事件日志
 */
async function logOrderEvent(
  supabase: any,
  orderId: string,
  action: string,
  fromStatus: OrderLifecycleStatus | null = null,
  toStatus: OrderLifecycleStatus | null = null,
  note: string | null = null,
  payload: any = null
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    console.warn('[OrdersRepo] Cannot log event: user not authenticated');
    return;
  }

  try {
    await (supabase.from('order_logs') as any).insert({
      order_id: orderId,
      actor_user_id: user.id,
      action,
      from_status: fromStatus,
      to_status: toStatus,
      note: note || null,
      payload: payload ? JSON.stringify(payload) : null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[OrdersRepo] Failed to log event:', error);
    }
  }
}

/**
 * D1: 激活订单
 * 
 * 流程：
 * 1. 校验订单未终结才能激活
 * 2. 写 order_logs：action='activate'
 * 3. 若该订单里程碑都未开始：把第一个里程碑设为'进行中'
 * 4. 自动 startExecution
 */
export async function activateOrder(
  orderId: string
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  // 获取订单
  const { data: order, error: getError } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (getError || !order) {
    return { error: getError?.message || 'Order not found' };
  }
  
  // 激活订单：直接记录日志和更新里程碑
  const updated = order;
  
  // 记录日志
  await logOrderEvent(
    supabase,
    orderId,
    'activate',
    '草稿',
    '已生效',
    '订单已激活，进入执行体系'
  );
  
  // 获取该订单的所有里程碑
  const { data: milestones } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('sequence_number', { ascending: true });
  
  // 如果所有里程碑都是"未开始"，将第一个设为"进行中"
  if (milestones && milestones.length > 0) {
    const allNotStarted = milestones.every((m: any) => {
      const status = m.status === 'pending' ? '未开始' : 
                     m.status === 'in_progress' ? '进行中' :
                     m.status === 'done' ? '已完成' :
                     m.status === 'blocked' ? '卡住' : m.status;
      return status === '未开始';
    });
    
    if (allNotStarted) {
      const firstMilestone = milestones[0];
      await transitionMilestoneStatus(firstMilestone.id, '进行中', '订单已激活，自动开始第一个执行步骤');
    }
  }
  
  // 自动开始执行（已生效 -> 执行中）
  const execResult = await startExecution(orderId);
  if (execResult.error) {
    // 如果启动执行失败，不影响激活，但记录警告
    console.warn('[OrdersRepo] Order activated but startExecution failed:', execResult.error);
  }
  
  return { data: updated };
}

/**
 * D2: 开始执行（已生效 -> 执行中）
 */
export async function startExecution(
  orderId: string
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: order, error: getError } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (getError || !order) {
    return { error: getError?.message || 'Order not found' };
  }
  
  // startExecution 不再需要更新任何字段，只是逻辑上的开始执行
  const { data: updated, error: updateError } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  await logOrderEvent(
    supabase,
    orderId,
    'lifecycle_transition',
    '已生效',
    '执行中',
    '订单开始执行'
  );
  
  return { data: updated };
}

/**
 * D3: 申请取消订单
 */
export async function requestCancel(
  orderId: string,
  reasonType: string,
  reasonDetail: string
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'User not authenticated' };
  }
  
  const { data: order, error: getError } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (getError || !order) {
    return { error: getError?.message || 'Order not found' };
  }
  
  // 插入取消申请
  const { data: cancelRequest, error: insertError } = await (supabase
    .from('cancel_requests') as any)
    .insert({
      order_id: orderId,
      requested_by: user.id,
      reason_type: reasonType,
      reason_detail: reasonDetail,
      status: 'pending',
    })
    .select()
    .single();
  
  if (insertError) {
    return { error: insertError.message };
  }
  
  await logOrderEvent(
    supabase,
    orderId,
    'cancel_request',
    null,
    null,
    `申请取消订单：${reasonDetail}`,
    { reason_type: reasonType, reason_detail: reasonDetail }
  );
  
  return { data: cancelRequest };
}

/**
 * D4: 审批取消申请
 */
export async function decideCancel(
  cancelRequestId: string,
  decision: 'approved' | 'rejected',
  decisionNote: string | null = null
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'User not authenticated' };
  }
  
  // 获取取消申请
  const { data: cancelRequest, error: getError } = await (supabase
    .from('cancel_requests') as any)
    .select('*, orders!inner(*)')
    .eq('id', cancelRequestId)
    .single();
  
  if (getError || !cancelRequest) {
    return { error: getError?.message || 'Cancel request not found' };
  }
  
  const orderId = cancelRequest.order_id;
  const order = cancelRequest.orders;
  
  // 校验：只有pending状态才能审批
  if (cancelRequest.status !== 'pending') {
    return { error: `取消申请状态为"${cancelRequest.status}"，无法审批。` };
  }
  
  // 更新取消申请状态
  const { data: updatedRequest, error: updateError } = await (supabase
    .from('cancel_requests') as any)
    .update({
      status: decision,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decision_note: decisionNote,
    })
    .eq('id', cancelRequestId)
    .select()
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  await logOrderEvent(
    supabase,
    orderId,
    'cancel_decision',
    null,
    null,
    `取消申请${decision === 'approved' ? '已批准' : '已拒绝'}：${decisionNote || ''}`,
    { decision, decision_note: decisionNote }
  );
  
  // 如果批准，执行取消订单
  if (decision === 'approved') {
    // 更新订单：记录取消信息
    const { data: updatedOrder, error: orderUpdateError } = await (supabase
      .from('orders') as any)
      .update({
        termination_type: '取消',
        termination_reason: cancelRequest.reason_detail,
        termination_approved_by: user.id,
      })
      .eq('id', orderId)
      .select()
      .single();
    
    if (orderUpdateError) {
      return { error: orderUpdateError.message };
    }
    
    await logOrderEvent(
      supabase,
      orderId,
      'terminate',
      '执行中',
      '已取消',
      `订单已取消：${cancelRequest.reason_detail}`
    );
    
    // 冻结所有未完成的里程碑
    const { data: milestones } = await (supabase
      .from('milestones') as any)
      .select('*')
      .eq('order_id', orderId);
    
    if (milestones) {
      for (const milestone of milestones) {
        const status = milestone.status === 'pending' ? '未开始' : 
                       milestone.status === 'in_progress' ? '进行中' :
                       milestone.status === 'done' ? '已完成' :
                       milestone.status === 'blocked' ? '卡住' : milestone.status;
        
        if (status !== '已完成') {
          // 追加notes：订单已取消
          const existingNotes = milestone.notes || '';
          const cancelNote = `\n[订单已取消] ${cancelRequest.reason_detail}`;
          await (supabase.from('milestones') as any)
            .update({ notes: existingNotes + cancelNote })
            .eq('id', milestone.id);
        }
      }
    }
    
    
    return { data: { cancelRequest: updatedRequest, order: updatedOrder } };
  }
  
  return { data: { cancelRequest: updatedRequest } };
}

/**
 * D5: 完成订单
 * 
 * 流程：
 * 1. 仅当订单已激活且未终结
 * 2. 仅当该订单所有 milestones.status='已完成' 才允许
 * 3. 更新 orders：termination_type='完成'
 * 4. 写 order_logs：action='terminate'
 */
export async function completeOrder(
  orderId: string
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: order, error: getError } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  
  if (getError || !order) {
    return { error: getError?.message || 'Order not found' };
  }
  
  // 校验：所有里程碑必须已完成
  const { data: milestones } = await (supabase
    .from('milestones') as any)
    .select('status')
    .eq('order_id', orderId);
  
  if (milestones && milestones.length > 0) {
    const allCompleted = milestones.every((m: any) => {
      const status = m.status === 'pending' ? '未开始' : 
                     m.status === 'in_progress' ? '进行中' :
                     m.status === 'done' ? '已完成' :
                     m.status === 'blocked' ? '卡住' : m.status;
      return status === '已完成';
    });
    
    if (!allCompleted) {
      return { error: '仍有未完成执行步骤，无法结案。请先完成所有里程碑。' };
    }
  }
  
  // 更新订单：设置完成信息
  const updateData: any = {
    termination_type: '完成',
  };
  
  const { data: updated, error: updateError } = await (supabase
    .from('orders') as any)
    .update(updateData)
    .eq('id', orderId)
    .select()
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  await logOrderEvent(
    supabase,
    orderId,
    'terminate',
    '执行中',
    order.retrospective_required ? '待复盘' : '已完成',
    '订单已完成'
  );
  
  // 如果进入待复盘，再记录一次转换
  if (order.retrospective_required) {
    await logOrderEvent(
      supabase,
      orderId,
      'lifecycle_transition',
      '已完成',
      '待复盘',
      '订单已完成，进入待复盘状态'
    );
  }
  
  return { data: updated };
}

/**
 * D6: 提交复盘
 * 
 * 流程：
 * 1. 仅当订单已终结、需要复盘且未完成复盘时才允许
 * 2. upsert order_retrospectives（owner_user_id=current user）
 * 3. 更新 orders：retrospective_completed_at=now()
 * 4. 写 order_logs：action='retrospective_submit'
 */
export async function submitRetrospective(
  orderId: string,
  payload: {
    on_time_delivery: boolean | null;
    major_delay_reason: string | null;
    key_issue: string;
    root_cause: string;
    what_worked: string;
    improvement_actions: Array<{
      action: string;
      owner_role: string;
      due_at: string | null;
      success_metric: string | null;
    }>;
  }
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'User not authenticated' };
  }
  
  const { data: order, error: getError } = await (supabase
    .from('orders') as any)
    .select('retrospective_required, retrospective_completed_at')
    .eq('id', orderId)
    .single();
  
  if (getError || !order) {
    return { error: getError?.message || 'Order not found' };
  }
  
  // 校验：需要复盘且未完成复盘的订单才能提交复盘
  if (!order.retrospective_required) {
    return { error: '该订单不需要复盘。' };
  }
  if (order.retrospective_completed_at) {
    return { error: '该订单已完成复盘，无法重复提交。' };
  }
  
  // 获取里程碑统计
  const { data: milestones } = await (supabase
    .from('milestones') as any)
    .select('status')
    .eq('order_id', orderId);
  
  const blockedCount = milestones?.filter((m: any) => {
    const status = m.status === 'pending' ? '未开始' : 
                   m.status === 'in_progress' ? '进行中' :
                   m.status === 'done' ? '已完成' :
                   m.status === 'blocked' ? '卡住' : m.status;
    return status === '卡住';
  }).length || 0;
  
  // 获取延迟申请统计
  const { data: delayRequests } = await (supabase
    .from('delay_requests') as any)
    .select('id')
    .eq('order_id', orderId);
  
  const delayRequestCount = delayRequests?.length || 0;
  
  // upsert order_retrospectives
  const { data: retrospective, error: retroError } = await (supabase
    .from('order_retrospectives') as any)
    .upsert({
      order_id: orderId,
      owner_user_id: user.id,
      on_time_delivery: payload.on_time_delivery,
      major_delay_reason: payload.major_delay_reason,
      blocked_count: blockedCount,
      delay_request_count: delayRequestCount,
      key_issue: payload.key_issue,
      root_cause: payload.root_cause,
      what_worked: payload.what_worked,
      improvement_actions: JSON.stringify(payload.improvement_actions),
    }, {
      onConflict: 'order_id',
    })
    .select()
    .single();
  
  if (retroError) {
    return { error: retroError.message };
  }
  
  // 更新订单状态：待复盘 -> 已复盘
  const { data: updated, error: updateError } = await (supabase
    .from('orders') as any)
    .update({
      retrospective_completed_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .select()
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  await logOrderEvent(
    supabase,
    orderId,
    'retrospective_submit',
    '待复盘',
    '已复盘',
    '订单复盘已提交'
  );
  
  return { data: { order: updated, retrospective } };
}
