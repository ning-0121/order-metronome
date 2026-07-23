/**
 * Orders Repository
 * 数据契约层：所有对 orders 表的写入必须通过此 repository
 */

import { createClient } from '@/lib/supabase/server';
import { isActiveStatus, isBlockedStatus, isDoneStatus, isPendingStatus, isApprovalPending, normalizeMilestoneStatus, transitionOrderLifecycle, type OrderLifecycleStatus } from '@/lib/domain/types';
import { createMilestone, transitionMilestoneStatus } from './milestonesRepo';

// ⚠️ 系统级约束：order_no 只能由系统生成，禁止外部传入
// 白名单字段（与数据库表结构一致）
// 注意：order_no 不在白名单中，由系统自动生成
const INSERT_WHITELIST = [
  'customer_name',
  'customer_id',
  'owner_user_id',
  'incoterm',
  'etd',
  'warehouse_due_date',
  'order_type',
  'packaging_type',
  'created_by',
  'notes',
  'style_no',
  'po_number',
  'quantity',
  'cancel_date',
  'colors',
  'sizes',
  'unit_price',
  'currency',
  'total_amount',
  'payment_terms',
  'shipment_qty',
  'order_date',
  'factory_id',
  'factory_name',
  'is_new_customer',
  'is_new_factory',
  'special_tags',
  'style_count',
  'color_count',
  'factory_date',
  'internal_order_no',
  'quantity_unit',
  'eta',
  'imported_at',
  'import_current_step',
  'delivery_type',
  'order_purpose',
  'parent_order_id',
  'sample_status',
  'product_description',
  'target_price',
  'quote_stage',
  // 订单灵活性增强（2026-04-07）
  'skip_pre_production_sample',
  'sample_confirm_days_override',
  'factory_ids',
  'factory_names',
  // 价格审批追溯（2026-04-08）
  'price_approval_id',
  // 样品阶段（2026-04-15）
  'sample_phase',
  // 国内送仓字段（2026-05-04）
  'delivery_warehouse_name',
  'delivery_address',
  'delivery_contact',
  'delivery_phone',
  'delivery_required_at',
  // AQL 验货标准（列 2026-05-18 已加，但白名单遗漏导致建单时被静默丢弃，2026-06-01 补回）
  'aql_standard',
  // AI 原始识别冻结底档（2026-07-03）
  'po_parse_snapshot',
  'po_parse_snapshot_at',
] as const;

const UPDATE_WHITELIST = [
  'customer_name',
  'customer_id',
  'incoterm',
  'etd',
  'warehouse_due_date',
  'order_type',
  'packaging_type',
  'notes',
  'style_no',
  'po_number',
  'quantity',
  'cancel_date',
  'colors',
  'sizes',
  'unit_price',
  'currency',
  'total_amount',
  'payment_terms',
  'shipment_qty',
  'order_date',
  'factory_id',
  'factory_name',
  'is_new_customer',
  'is_new_factory',
  'special_tags',
  'style_count',
  'color_count',
  'factory_date',
  'internal_order_no',
  'quantity_unit',
  'eta',
  'delivery_type',
  'order_purpose',
  'sample_status',
  'product_description',
  'target_price',
  'quote_stage',
  'is_split_shipment',
  'total_batches',
  // 订单灵活性增强（2026-04-07）
  'skip_pre_production_sample',
  'sample_confirm_days_override',
  'factory_ids',
  'factory_names',
  // 国内送仓字段（2026-05-04）
  'delivery_warehouse_name',
  'delivery_address',
  'delivery_contact',
  'delivery_phone',
  'delivery_required_at',
  // AQL 验货标准（同 INSERT，避免编辑订单时被静默丢弃，2026-06-01 补回）
  'aql_standard',
  // AI 原始识别冻结底档（2026-07-03，供「再冻结」更新）
  'po_parse_snapshot',
  'po_parse_snapshot_at',
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
  // packaging_type 默认值（表单可能不传此字段）
  if (!sanitized.packaging_type) {
    sanitized.packaging_type = 'standard';
  }
  
  // Incoterm 特定验证：DDP需要ETD和ETA，其他只需要出厂日期
  if (sanitized.incoterm === 'DDP' && !sanitized.etd) {
    return { error: 'DDP订单必须填写ETD' };
  }
  if (sanitized.incoterm === 'DDP' && !sanitized.warehouse_due_date) {
    return { error: 'DDP订单必须填写ETA（到仓日期）' };
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
  
  // Incoterm 特定验证（DDP需要ETD，FOB/RMB不需要）
  
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

  // ── quantity / total_amount 守恒（2026-05-19）──
  // 之前 quantity 和 total_amount 都在 UPDATE_WHITELIST 里独立可改，
  // 无 total_amount = quantity × unit_price 校验。修了 quantity 后
  // total_amount 不重算，财务报表错。
  // 规则：
  //   - 同时改 quantity + total_amount → 信任前端（业务可能在 UI 上一起改）
  //   - 只改 quantity，不改 total_amount → 自动重算（从 DB 读 unit_price 算）
  //   - 只改 unit_price → 自动重算 total_amount
  if (
    ('quantity' in sanitized && !('total_amount' in sanitized)) ||
    ('unit_price' in sanitized && !('total_amount' in sanitized))
  ) {
    const { data: cur } = await (supabase.from('orders') as any)
      .select('quantity, unit_price')
      .eq('id', id)
      .single();
    const effQty = (sanitized.quantity ?? cur?.quantity) as number | null;
    const effPrice = (sanitized.unit_price ?? cur?.unit_price) as number | null;
    if (effQty != null && effPrice != null && !Number.isNaN(effQty) && !Number.isNaN(effPrice)) {
      sanitized.total_amount = Math.round(effQty * effPrice * 100) / 100;
    }
  }

  // ── Lifecycle State Machine 校验（2026-05-18, P1）──
  // 禁止非法状态转移（如 completed → active 回滚）
  if (sanitized.lifecycle_status) {
    const { data: { user } } = await supabase.auth.getUser();
    let adminOverride = false;
    if (user) {
      const { data: profile } = await (supabase.from('profiles') as any)
        .select('role, roles').eq('user_id', user.id).single();
      const roles: string[] = (profile as any)?.roles?.length > 0
        ? (profile as any).roles
        : [(profile as any)?.role].filter(Boolean);
      adminOverride = roles.includes('admin');
    }
    const { data: existing } = await (supabase.from('orders') as any)
      .select('lifecycle_status').eq('id', id).single();
    const fromStatus = (existing as any)?.lifecycle_status;
    const { validateTransition } = await import('@/lib/domain/lifecycleStateMachine');
    const transitionErr = validateTransition(fromStatus, sanitized.lifecycle_status, adminOverride);
    if (transitionErr) return { error: transitionErr };
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
  
  // 激活订单：更新 lifecycle_status
  const { data: updated, error: updateErr } = await (supabase
    .from('orders') as any)
    .update({ lifecycle_status: 'active', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .select('*')
    .single();
  if (updateErr) return { error: updateErr.message };

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
      const status = normalizeMilestoneStatus(m.status);
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
  
  // 更新 lifecycle_status 为执行中
  const { data: updated, error: updateError } = await (supabase
    .from('orders') as any)
    .update({ lifecycle_status: 'active', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .select('*')
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

  // 采购已启动(material_plans active)后,业务不能"直接执行"取消,但【可提交取消申请】给管理员审批。
  // 2026-07-08 用户:此前这里硬拦住,业务提交即被拒、管理员根本收不到申请 → 改为放行申请并标注"采购已启动",
  //   走同一套 cancel_requests(pending)+ 通知财务/管理员,由管理员特批(不再"联系管理员"却无入口)。
  const { data: reqProfile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).maybeSingle();
  const reqRoles: string[] = (reqProfile as any)?.roles?.length ? (reqProfile as any).roles : [(reqProfile as any)?.role].filter(Boolean);
  let procurementStarted = false;
  if (!reqRoles.includes('admin')) {
    const { data: activePlan } = await (supabase.from('material_plans') as any)
      .select('id').eq('order_id', orderId).eq('plan_status', 'active').limit(1).maybeSingle();
    procurementStarted = !!activePlan;
  }
  const finalDetail = procurementStarted ? `[采购已启动·需管理员特批] ${reasonDetail}` : reasonDetail;

  // 防重：同一订单已有待审批的取消申请时，不允许重复提交（对齐延期流程的守卫）
  const { data: existingPending } = await (supabase
    .from('cancel_requests') as any)
    .select('id')
    .eq('order_id', orderId)
    .eq('status', 'pending')
    .limit(1);
  if (existingPending && existingPending.length > 0) {
    return { error: '该订单已有待审批的取消申请，请等待管理员处理后再提交' };
  }

  // 插入取消申请
  const { data: cancelRequest, error: insertError } = await (supabase
    .from('cancel_requests') as any)
    .insert({
      order_id: orderId,
      requested_by: user.id,
      reason_type: reasonType,
      reason_detail: finalDetail,
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
    `申请取消订单：${finalDetail}`,
    { reason_type: reasonType, reason_detail: finalDetail }
  );

  // 通知财务(+管理员):有取消申请待审批 —— 否则审批人永远不知道有东西要审(2026-07-04 用户反馈)
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(supabase, ['finance', 'admin'], {
      type: 'cancel_approval',
      title: `🔴 取消订单待审批：${(order as any)?.order_no || ''}${procurementStarted ? '(采购已启动·需特批)' : ''}`,
      message: `订单 ${(order as any)?.order_no || orderId}（${(order as any)?.customer_name || ''}）申请取消；原因：${finalDetail}。请到该订单页审批取消申请。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[requestCancel] 取消待审批通知失败(不阻断):', e?.message); }

  // H3:发起端 —— 推给财务系统审批队列(财务接 cancel.requested → 队列 → 批/驳回传 approval_type:'cancel')
  try {
    const { data: reqProf } = await (supabase.from('profiles') as any).select('name').eq('user_id', user.id).maybeSingle();
    const { syncCancelRequestToFinance } = await import('@/lib/integration/finance-sync');
    await syncCancelRequestToFinance({
      id: (cancelRequest as any).id,
      order_no: (order as any)?.order_no ?? null,
      customer_name: (order as any)?.customer_name ?? null,
      requester_name: (reqProf as any)?.name ?? null,
      summary: `订单取消申请:${reasonType}`,
      // 结构化:原因 + 订单金额(财务据此判取消影响的资金),财务按 KEY_LABEL 中文铺开
      detail: {
        reason: reasonDetail,
        amount: (order as any)?.total_amount ?? null,
        currency: (order as any)?.currency ?? null,
      },
      created_at: (cancelRequest as any).created_at,
    });
  } catch (e: any) { console.warn('[requestCancel] 发财务取消审批请求失败(已落 outbox/不阻断):', e?.message); }

  return { data: cancelRequest };
}

/**
 * D4: 审批取消申请
 */
export async function decideCancel(
  cancelRequestId: string,
  decision: 'approved' | 'rejected',
  decisionNote: string | null = null,
  override?: { supabase?: any; actorId?: string | null }, // H3:财务回调用 service-role 调,无用户会话
): Promise<{ data?: any; error?: string }> {
  const supabase = override?.supabase || await createClient();
  let actorId: string | null = override?.actorId ?? null;
  if (!override?.supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: 'User not authenticated' };
    actorId = user.id;
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
  if (!isApprovalPending(cancelRequest.status)) {
    return { error: `取消申请状态为"${cancelRequest.status}"，无法审批。` };
  }
  
  // 更新取消申请状态
  const { data: updatedRequest, error: updateError } = await (supabase
    .from('cancel_requests') as any)
    .update({
      status: decision,
      decided_by: actorId,
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
        lifecycle_status: 'cancelled', // 关键修复：之前只写 termination_*，没改 lifecycle → 半状态
        terminated_at: new Date().toISOString(),
        termination_type: '取消',
        termination_reason: cancelRequest.reason_detail,
        termination_approved_by: actorId,
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
        const status = normalizeMilestoneStatus(milestone.status);

        if (!isDoneStatus(status)) {
          // 追加notes：订单已取消
          const existingNotes = milestone.notes || '';
          const cancelNote = `\n[订单已取消] ${cancelRequest.reason_detail}`;
          await (supabase.from('milestones') as any)
            .update({ notes: existingNotes + cancelNote })
            .eq('id', milestone.id);
        }
      }
    }
    // 同一订单的其它待审批取消申请：本单已取消，一并关闭，避免残留 pending 刷屏
    await (supabase.from('cancel_requests') as any)
      .update({
        status: 'rejected',
        decided_by: actorId,
        decided_at: new Date().toISOString(),
        decision_note: '订单已因其它取消申请而取消，本申请自动关闭',
      })
      .eq('order_id', orderId)
      .eq('status', 'pending')
      .neq('id', cancelRequestId);

    return { data: { cancelRequest: updatedRequest, order: updatedOrder } };
  }

  return { data: { cancelRequest: updatedRequest } };
}

/**
 * 取消订单的下游清理(PO 作废 / 未收货执行行 cancelled / 清风险投影 / 通知财务+采购+生产)。
 * 内部审批(decideCancelAction)与财务回调(finance-callback H3)共用同一套清理,传入对应 client。
 */
export async function finalizeCancelledOrder(client: any, orderId: string): Promise<void> {
  const poNos: string[] = [];
  const pendingApprovalPos: Array<{ id: string; po_no: string | null }> = []; // 待财务审批的 PO → 取消单后通知财务撤审批
  try {
    const { data: pos } = await (client.from('purchase_orders') as any)
      .select('id, po_no, order_ids, status, approval_status').contains('order_ids', [orderId]);
    for (const po of (pos || [])) {
      if ((po as any).po_no) poNos.push((po as any).po_no);
      if ((po as any).approval_status === 'pending') pendingApprovalPos.push({ id: (po as any).id, po_no: (po as any).po_no ?? null });
      const remain = ((po as any).order_ids || []).filter((x: string) => x !== orderId);
      const settled = ['received', 'closed'].includes((po as any).status);
      if (remain.length === 0 && !settled) {
        await (client.from('purchase_orders') as any).update({ status: 'cancelled', order_ids: [], updated_at: new Date().toISOString() }).eq('id', (po as any).id);
      } else {
        await (client.from('purchase_orders') as any).update({ order_ids: remain, updated_at: new Date().toISOString() }).eq('id', (po as any).id);
      }
    }
    await (client.from('procurement_line_items') as any)
      .update({ line_status: 'cancelled' }).eq('order_id', orderId)
      .not('line_status', 'in', '("received","accepted","closed","concession","cancelled")');
    await (client.from('runtime_orders') as any).delete().eq('order_id', orderId);
  } catch (e: any) { console.warn('[finalizeCancelledOrder] 采购/风险清理失败(不阻断):', e?.message); }
  try {
    const { data: ord } = await (client.from('orders') as any).select('order_no, internal_order_no, customer_name').eq('id', orderId).maybeSingle();
    const { notifyOrderCancelled, cancelPurchaseOrderApproval } = await import('@/lib/integration/finance-sync');
    await notifyOrderCancelled({ id: orderId, lifecycle_status: '已取消', order_no: (ord as any)?.order_no ?? null, internal_order_no: (ord as any)?.internal_order_no ?? null, customer_name: (ord as any)?.customer_name ?? null, po_nos: poNos } as Record<string, unknown>);
    // 取消单 → 撤掉挂在财务「采购审批」队列里的待审 PO
    for (const p of pendingApprovalPos) {
      await cancelPurchaseOrderApproval({ purchase_order_id: p.id, po_no: p.po_no, order_id: orderId, reason: 'order_cancelled' });
    }
  } catch (e: any) { console.warn('[finalizeCancelledOrder] 财务冲销通知失败(不阻断):', e?.message); }
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(client, ['procurement', 'procurement_manager', 'production', 'production_manager'], {
      type: 'order_cancelled', title: '🛑 订单已取消,停止采购/生产',
      message: '关联订单已取消,系统已作废其未收货的采购单/执行行。请勿再为此单下单、催货或排产。', relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[finalizeCancelledOrder] 取消通知采购/生产失败(不阻断):', e?.message); }
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
      const status = normalizeMilestoneStatus(m.status);
      return status === '已完成';
    });
    
    if (!allCompleted) {
      return { error: '仍有未完成执行步骤，无法结案。请先完成所有里程碑。' };
    }
  }
  
  // 更新订单：设置完成信息
  // 2026-05-19：之前只设 termination_type='完成'，没更新 lifecycle_status
  // → 订单可能处于「active + 已终止」混淆态，dashboard / cron / 查询
  // 用 lifecycle_status 过滤的地方都看不到这单是 done。
  const updateData: any = {
    termination_type: '完成',
    lifecycle_status: 'completed',
    terminated_at: new Date().toISOString(),
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
    const status = isPendingStatus(m.status) ? '未开始' : 
                   isActiveStatus(m.status) ? '进行中' :
                   isDoneStatus(m.status) ? '已完成' :
                   isBlockedStatus(m.status) ? '卡住' : m.status;
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
