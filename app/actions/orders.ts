'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { MILESTONE_TEMPLATE_V1, getApplicableMilestones } from '@/lib/milestoneTemplate';
import { calcDueDates, recalcRemainingDueDates } from '@/lib/schedule';
import { subtractWorkingDays, ensureBusinessDay } from '@/lib/utils/date';
import { 
  createOrder as createOrderRepo, 
  deleteOrder, 
  generateOrderNo,
  activateOrder,
  startExecution,
  requestCancel,
  decideCancel,
  completeOrder,
  submitRetrospective,
} from '@/lib/repositories/ordersRepo';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import type { IncotermType, OrderType, PackagingType } from '@/lib/types';

/**
 * ⚠️ 系统级函数：预生成订单号（用于向导预生成）
 * 
 * 用途：在 New Order 向导 Step 1 页面加载时预生成订单号
 * 约束：订单号一旦生成，永不回收、不修改
 */
export async function preGenerateOrderNo() {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  // 验证邮箱域名
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }
  
  const { orderNo, error } = await generateOrderNo();
  
  if (error || !orderNo) {
    return { error: error || 'Failed to generate order number' };
  }
  
  return { orderNo };
}

/**
 * ⚠️ 系统级函数：创建订单（Server Action）
 * 
 * 约束：
 * - order_no 必须由系统生成（通过 preGenerateOrderNo 预生成）
 * - 禁止从 formData 读取 order_no
 */
export async function createOrder(
  formData: FormData,
  preGeneratedOrderNo?: string
): Promise<{ ok: boolean; orderId?: string; error?: string; warning?: string }> {
  // ── STEP 1: validate — 验证用户身份 ──
  let supabase;
  try {
    supabase = await createClient();
  } catch (e: any) {
    console.error('[createOrder] STEP 1 FAIL: Supabase 客户端初始化失败 —', e.message);
    return { ok: false, error: '系统初始化失败，请刷新页面重试' };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    console.error('[createOrder] STEP 1 FAIL: 未登录 —', authError?.message);
    return { ok: false, error: '请先登录后再创建订单' };
  }
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { ok: false, error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }

  // 权限：仅业务/理单角色可创建订单
  const { data: creatorProfile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const creatorRoles: string[] = (creatorProfile as any)?.roles?.length > 0 ? (creatorProfile as any).roles : [(creatorProfile as any)?.role].filter(Boolean);
  const canCreate = creatorRoles.some(r => r === 'sales');
  if (!canCreate) {
    return { ok: false, error: '仅业务/理单角色可以创建订单' };
  }

  if (!preGeneratedOrderNo) {
    return { ok: false, error: '订单号未生成，请刷新页面重试' };
  }
  // ── STEP 2: validate — 提取并校验表单字段 ──
  const customer_name = formData.get('customer_name') as string;
  const customer_id = formData.get('customer_id') as string;
  if (!customer_name || !customer_id) {
    return { ok: false, error: '请选择客户（customer_name 或 customer_id 为空）' };
  }

  const incoterm = formData.get('incoterm') as IncotermType;
  if (!incoterm) return { ok: false, error: '请选择贸易条款（FOB / DDP）' };

  const order_type = formData.get('order_type') as OrderType;
  if (!order_type) return { ok: false, error: '请选择订单类型' };

  const etd = formData.get('etd') as string | null;
  const warehouse_due_date = formData.get('warehouse_due_date') as string | null;
  const order_date = formData.get('order_date') as string | null;
  const cancel_date = formData.get('cancel_date') as string | null;
  const factory_date = formData.get('factory_date') as string | null;
  const eta = formData.get('eta') as string | null;
  const shipping_sample_required = formData.get('shipping_sample_required') === 'true';
  const shipping_sample_deadline = formData.get('shipping_sample_deadline') as string | null;
  const factory_name = formData.get('factory_name') as string | null;
  const factory_id = formData.get('factory_id') as string | null;
  const totalQuantity = formData.get('total_quantity') as string | null;
  const quantity = totalQuantity ? parseInt(totalQuantity, 10) : null;
  const styleCount = formData.get('style_count') as string | null;
  const colorCount = formData.get('color_count') as string | null;

  if (!etd) return { ok: false, error: '请填写 ETD（离港日）' };
  if (!warehouse_due_date) return { ok: false, error: '请填写 ETA（到港/到仓日）' };
  if (!factory_date) return { ok: false, error: '请填写出厂日期' };
  if (!quantity) return { ok: false, error: '请填写预估总数量' };
  if (!styleCount) return { ok: false, error: '请填写款数' };
  if (!colorCount) return { ok: false, error: '请填写颜色数' };
  // ── STEP 3: insert order — 写入订单到数据库 ──
  // order_type: trial/bulk/repeat/urgent（DB CHECK 需更新）
  const dbOrderType = order_type || 'bulk';

  // 首单自动识别 + 手动覆盖
  const manualNewCustomer = formData.get('new_customer') === 'true';
  const manualNewFactory = formData.get('new_factory') === 'true';
  let isNewCustomer = manualNewCustomer;
  let isNewFactory = manualNewFactory;
  // 自动检测：查该客户/工厂历史订单数
  if (customer_id && !manualNewCustomer) {
    const { count } = await (supabase.from('orders') as any).select('id', { count: 'exact', head: true }).eq('customer_id', customer_id);
    if (count === 0) isNewCustomer = true;
  }
  if (factory_id && !manualNewFactory) {
    const { count } = await (supabase.from('orders') as any).select('id', { count: 'exact', head: true }).eq('factory_id', factory_id);
    if (count === 0) isNewFactory = true;
  }

  const insertPayload: Record<string, any> = {
    customer_name,
    customer_id,
    owner_user_id: user.id,
    incoterm,
    etd: etd || null,
    warehouse_due_date: warehouse_due_date || null,
    order_type: dbOrderType,
    packaging_type: 'standard' as PackagingType,
    cancel_date: cancel_date || null,
    order_date: order_date || null,
    factory_id: factory_id || null,
    factory_name: factory_name || null,
    is_new_customer: isNewCustomer,
    is_new_factory: isNewFactory,
    created_by: user.id,
    quantity: quantity,
    style_count: styleCount ? parseInt(styleCount, 10) : null,
    color_count: colorCount ? parseInt(colorCount, 10) : null,
    factory_date: factory_date || null,
    eta: eta || warehouse_due_date || null,
    notes: (formData.get('notes') as string) || null,
    special_tags: [
      formData.get('has_plus_size') === 'true' ? '大码款' : '',
      formData.get('high_stretch') === 'true' ? '高弹面料' : '',
      formData.get('light_color_risk') === 'true' ? '浅色风险' : '',
      formData.get('color_clash_risk') === 'true' ? '撞色风险' : '',
      formData.get('complex_print') === 'true' ? '复杂印花' : '',
      formData.get('tight_deadline') === 'true' ? '交期紧急' : '',
    ].filter(Boolean),
  };

  let orderData: any;
  try {
    const { data: order, error: orderError } = await createOrderRepo(insertPayload, preGeneratedOrderNo);
    if (orderError || !order) {
      console.error('[createOrder] STEP 3 FAIL: 订单写入失败 —', orderError);
      return { ok: false, error: `订单写入数据库失败：${orderError || '未知错误'}` };
    }
    orderData = order;
  } catch (e: any) {
    console.error('[createOrder] STEP 3 EXCEPTION:', e.message);
    return { ok: false, error: `订单写入异常：${e.message}` };
  }

  // ── STEP 4: create milestones — 计算排期 ──
  // ── STEP 4: create milestones — 计算排期 ──
  let dueDates: ReturnType<typeof calcDueDates>;
  try {
    dueDates = calcDueDates({
      orderDate: order_date,
      createdAt: new Date(orderData.created_at),
      incoterm: incoterm as 'FOB' | 'DDP',
      etd: etd,
      warehouseDueDate: warehouse_due_date,
      eta: eta,
      orderType: (order_type as 'sample' | 'bulk' | 'repeat') || 'bulk',
      shippingSampleRequired: shipping_sample_required,
      shippingSampleDeadline: shipping_sample_deadline,
    });
  } catch (scheduleErr: any) {
    console.error('[createOrder] STEP 4 FAIL: calcDueDates —', scheduleErr.message);
    await deleteOrder(orderData.id);
    return { ok: false, error: `排期计算失败：${scheduleErr.message}` };
  }

  // 角色映射：确保模板角色值 → DB 合法值
  const ROLE_TO_DB: Record<string, string> = {
    sales: 'sales', finance: 'finance', procurement: 'procurement',
    production: 'production', qc: 'qc', logistics: 'logistics',
    admin: 'admin', merchandiser: 'merchandiser', quality: 'qc',
  };

  const templates = getApplicableMilestones(order_type, shipping_sample_required);
  const milestonesData = [];
  for (let index = 0; index < templates.length; index++) {
    const template = templates[index];
    const dueAt = dueDates[template.step_key as keyof typeof dueDates];
    if (!dueAt) {
      console.error('[createOrder] STEP 4 FAIL: 缺少排期 step_key:', template.step_key);
      await deleteOrder(orderData.id);
      return { ok: false, error: `里程碑排期缺失：${template.step_key}（${template.name}）` };
    }
    const dbRole = ROLE_TO_DB[template.owner_role] || 'sales';
    // 仅业务角色的关卡自动分配给订单创建者（跟单由管理员另行指定）
    const autoAssign = dbRole === 'sales' ? user.id : null;
    milestonesData.push({
      step_key: template.step_key,
      name: template.name,
      owner_role: dbRole,
      owner_user_id: autoAssign,
      planned_at: ensureBusinessDay(dueAt).toISOString(),
      due_at: ensureBusinessDay(dueAt).toISOString(),
      status: index === 0 ? 'in_progress' : 'pending',
      is_critical: template.is_critical,
      evidence_required: template.evidence_required,
      evidence_note: (template as any).evidence_note || null,
      blocks: (template as any).blocks || [],
      notes: null,
      sequence_number: index + 1,
    });
  }
  // ── STEP 5: create milestones — RPC 写入里程碑 ──
  try {
    const { error: rpcError } = await (supabase.rpc as any)('init_order_milestones', {
      _order_id: orderData.id,
      _milestones_data: milestonesData,
    });
    if (rpcError) {
      console.error('[createOrder] STEP 5 FAIL: RPC —', rpcError.message);
      await deleteOrder(orderData.id);
      return { ok: false, error: `里程碑初始化失败：${rpcError.message}` };
    }
  } catch (rpcEx: any) {
    console.error('[createOrder] STEP 5 EXCEPTION:', rpcEx.message);
    await deleteOrder(orderData.id);
    return { ok: false, error: `里程碑初始化异常：${rpcEx.message}` };
  }
  // ── STEP 6: 历史导入模式处理 ──
  const isImport = formData.get('is_import') === 'true';
  const importCurrentStep = formData.get('import_current_step') as string | null;

  if (isImport && importCurrentStep) {
    try {
      // 6a. 更新订单标记
      await (supabase.from('orders') as any)
        .update({ imported_at: new Date().toISOString(), import_current_step: importCurrentStep })
        .eq('id', orderData.id);

      // 6b. 找到当前阶段在模板中的 index
      const currentIndex = templates.findIndex(t => t.step_key === importCurrentStep);
      if (currentIndex >= 0) {
        // 获取刚创建的所有里程碑
        const { data: createdMilestones } = await (supabase.from('milestones') as any)
          .select('id, step_key, due_at, sequence_number')
          .eq('order_id', orderData.id)
          .order('sequence_number', { ascending: true });

        if (createdMilestones && createdMilestones.length > 0) {
          const currentSeq = currentIndex + 1; // sequence_number 从 1 开始

          // 6c. 已完成节点：status='done', actual_at=due_at
          const doneIds = createdMilestones
            .filter((m: any) => m.sequence_number < currentSeq)
            .map((m: any) => m.id);
          if (doneIds.length > 0) {
            for (const mId of doneIds) {
              const ms = createdMilestones.find((m: any) => m.id === mId);
              await (supabase.from('milestones') as any)
                .update({ status: 'done', actual_at: ms.due_at })
                .eq('id', mId);
            }
          }

          // 6d. 当前节点：status='in_progress'
          const currentMs = createdMilestones.find((m: any) => m.sequence_number === currentSeq);
          if (currentMs) {
            await (supabase.from('milestones') as any)
              .update({ status: 'in_progress' })
              .eq('id', currentMs.id);
          }

          // 6e. 重算剩余节点 due_at
          // 计算锚点（与 calcDueDates 同逻辑）
          let anchorStr = incoterm === 'FOB' ? etd : (eta || warehouse_due_date);
          if (anchorStr) {
            const rawAnchor = new Date(anchorStr + 'T00:00:00+08:00');
            const anchor = incoterm === 'DDP' ? new Date(rawAnchor.getTime() - 25 * 86400000) : rawAnchor;
            const today = new Date();

            const newDates = recalcRemainingDueDates(importCurrentStep, anchor, today);

            // 更新当前及之后节点的 due_at 和 planned_at
            const remainingMs = createdMilestones.filter((m: any) => m.sequence_number >= currentSeq);
            for (const ms of remainingMs) {
              const newDate = newDates[ms.step_key];
              if (newDate) {
                const dateStr = ensureBusinessDay(newDate).toISOString();
                await (supabase.from('milestones') as any)
                  .update({ due_at: dateStr, planned_at: dateStr })
                  .eq('id', ms.id);
              }
            }
          }
        }
      }
    } catch (importErr: any) {
      console.warn('[createOrder] 导入模式处理失败（不影响订单创建）:', importErr.message);
    }
  }

  // ── 通知管理员：新订单已创建 ──
  try {
    const { data: creatorName } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
    const name = (creatorName as any)?.name || user.email?.split('@')[0] || '业务';
    const { data: admins } = await (supabase.from('profiles') as any)
      .select('user_id').or("role.eq.admin,roles.cs.{admin}");
    for (const admin of admins || []) {
      await (supabase.from('notifications') as any).insert({
        user_id: admin.user_id,
        type: 'new_order',
        title: `${name} 创建了新订单 ${preGeneratedOrderNo}`,
        message: `客户：${customer_name}，数量：${quantity || '未填'}`,
        related_order_id: orderData.id,
        status: 'unread',
      }).catch(() => {});
    }
  } catch {} // 通知失败不阻断订单创建

  // ── DONE ──
  revalidatePath('/orders');
  revalidatePath('/dashboard');
  return { ok: true, orderId: orderData.id };
}

export async function getOrders() {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, factory_name, factory_id, incoterm, etd, warehouse_due_date, order_type, packaging_type, notes, created_at, style_no, po_number, quantity, cancel_date, order_date, special_tags')
    .order('created_at', { ascending: false });
  
  if (error) {
    return { error: error.message };
  }
  
  // Get milestones for each order to compute status
  if (orders) {
    for (const orderItem of orders) {
      const orderData = orderItem as any;
      const { data: milestones } = await supabase
        .from('milestones')
        .select('*')
        .eq('order_id', orderData.id);
      
      if (milestones) {
        orderData.milestones = milestones;
      }
    }
  }
  
  return { data: orders };
}

export async function getOrder(id: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: order };
}

export async function updateOrder(id: string, formData: FormData) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 权限检查：只有订单创建者或 admin 可以修改
  const { data: existingOrder } = await (supabase.from('orders') as any)
    .select('created_by')
    .eq('id', id)
    .single();
  if (!existingOrder) {
    return { error: '订单不存在' };
  }
  const { isAdmin: isAdminUser } = await getCurrentUserRole(supabase);
  if (existingOrder.created_by !== user.id && !isAdminUser) {
    return { error: '无权修改此订单' };
  }

  const updates: Record<string, any> = {};
  const fields = ['customer_name', 'order_no', 'order_type', 'packaging_type'];
  
  fields.forEach((field) => {
    const value = formData.get(field);
    if (value) {
      updates[field] = value;
    }
  });
  
  const incoterm = formData.get('incoterm') as IncotermType | null;
  if (incoterm) {
    updates.incoterm = incoterm;
    const etd = formData.get('etd') as string | null;
    const warehouse_due_date = formData.get('warehouse_due_date') as string | null;
    
    if (incoterm === 'FOB') {
      updates.etd = etd;
      updates.warehouse_due_date = null;
    } else {
      updates.warehouse_due_date = warehouse_due_date;
      updates.etd = null;
    }
  }
  
  // 使用 repository 更新订单
  const { updateOrder: updateOrderRepo } = await import('@/lib/repositories/ordersRepo');
  const { data: order, error } = await updateOrderRepo(id, updates);
  
  if (error) {
    return { error };
  }
  
  revalidatePath(`/orders/${id}`);
  revalidatePath('/orders');
  
  return { data: order };
}

// =========================
// 订单生命周期管理 Actions (V1.6)
// =========================

/**
 * 激活订单
 */
export async function activateOrderAction(orderId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 权限检查：只有订单创建者或 admin 可以激活
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by')
    .eq('id', orderId)
    .single();
  if (!order) {
    return { error: '订单不存在' };
  }
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (order.created_by !== user.id && !isAdmin) {
    return { error: '无权操作此订单' };
  }

  const result = await activateOrder(orderId);
  
  if (result.error) {
    return { error: result.error };
  }
  
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');
  
  return { data: result.data };
}

/**
 * 申请取消订单
 */
export async function requestCancelAction(
  orderId: string,
  reasonType: string,
  reasonDetail: string
) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const result = await requestCancel(orderId, reasonType, reasonDetail);
  
  if (result.error) {
    return { error: result.error };
  }
  
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  
  return { data: result.data };
}

/**
 * 审批取消申请
 */
export async function decideCancelAction(
  cancelRequestId: string,
  decision: 'approved' | 'rejected',
  decisionNote: string | null = null
) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 权限检查：只有 admin 可以审批取消申请
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) {
    return { error: '无权审批：只有管理员可以审批取消申请' };
  }

  const result = await decideCancel(cancelRequestId, decision, decisionNote);
  
  if (result.error) {
    return { error: result.error };
  }
  
  // 获取订单ID以便revalidate（从result中获取）
  if (result.data && typeof result.data === 'object' && 'cancelRequest' in result.data) {
    const cancelRequest = (result.data as any).cancelRequest;
    if (cancelRequest && cancelRequest.order_id) {
      revalidatePath(`/orders/${cancelRequest.order_id}`);
      revalidatePath('/orders');
      revalidatePath('/dashboard');
    }
  } else {
    // 如果result中没有order_id，从cancelRequestId查询
    const { data: cancelRequest } = await supabase
      .from('cancel_requests')
      .select('order_id')
      .eq('id', cancelRequestId)
      .single();
    
    if (cancelRequest && (cancelRequest as any).order_id) {
      revalidatePath(`/orders/${(cancelRequest as any).order_id}`);
      revalidatePath('/orders');
      revalidatePath('/dashboard');
    }
  }
  
  return { data: result.data };
}

/**
 * 完成订单
 */
export async function completeOrderAction(orderId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 权限检查：只有订单创建者或 admin 可以完成订单
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by')
    .eq('id', orderId)
    .single();
  if (!order) {
    return { error: '订单不存在' };
  }
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (order.created_by !== user.id && !isAdmin) {
    return { error: '无权操作此订单' };
  }

  const result = await completeOrder(orderId);

  if (result.error) {
    return { error: result.error };
  }

  // 订单完成后自动计算执行评分
  try {
    const { calculateOrderScore } = await import('@/app/actions/commissions');
    await calculateOrderScore(orderId);
  } catch (e) {
    console.warn('[completeOrder] 评分计算失败（不影响订单完成）:', e);
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');

  return { data: result.data };
}

/**
 * 提交复盘
 */
export async function submitRetrospectiveAction(
  orderId: string,
  formData: FormData
) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 权限：仅订单创建者或管理员可提交复盘
  const { data: retroOrder } = await (supabase.from('orders') as any)
    .select('created_by')
    .eq('id', orderId)
    .single();
  if (!retroOrder) return { error: '订单不存在' };
  const { isAdmin: isRetroAdmin } = await getCurrentUserRole(supabase);
  if (retroOrder.created_by !== user.id && !isRetroAdmin) {
    return { error: '仅订单创建者或管理员可提交复盘' };
  }

  const payload = {
    on_time_delivery: formData.get('on_time_delivery') === 'true' ? true : 
                     formData.get('on_time_delivery') === 'false' ? false : null,
    major_delay_reason: formData.get('major_delay_reason') as string | null,
    key_issue: formData.get('key_issue') as string,
    root_cause: formData.get('root_cause') as string,
    what_worked: formData.get('what_worked') as string,
    improvement_actions: JSON.parse(formData.get('improvement_actions') as string || '[]'),
  };
  
  // 验证必填字段
  if (!payload.key_issue || !payload.root_cause || !payload.what_worked) {
    return { error: '关键问题、根本原因、做得好的地方为必填项' };
  }
  
  if (!Array.isArray(payload.improvement_actions) || payload.improvement_actions.length === 0) {
    return { error: '至少需要添加一条改进措施' };
  }
  
  const result = await submitRetrospective(orderId, payload);
  
  if (result.error) {
    return { error: result.error };
  }
  
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}/retrospective`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');
  
  return { data: result.data };
}

/**
 * 获取订单日志
 */
export async function getOrderLogs(orderId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  // 从 milestone_logs 读取
  const { data: logs, error } = await (supabase
    .from('milestone_logs') as any)
    .select('id, milestone_id, order_id, action, note, actor_user_id, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return { error: error.message };
  }

  // 批量查询操作人姓名
  const actorIds = [...new Set((logs || []).map((l: any) => l.actor_user_id).filter(Boolean))];
  let profileMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: profiles } = await (supabase
      .from('profiles') as any)
      .select('user_id, full_name')
      .in('user_id', actorIds);
    profileMap = (profiles || []).reduce((m: any, p: any) => { m[p.user_id] = p.full_name; return m; }, {});
  }

  // 附加姓名到日志
  const logsWithNames = (logs || []).map((l: any) => ({
    ...l,
    actor_name: profileMap[l.actor_user_id] || null,
  }));

  return { data: logsWithNames };
}

/**
 * 获取取消申请
 */
export async function getCancelRequests(orderId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: requests, error } = await supabase
    .from('cancel_requests')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: requests };
}

/**
 * 获取复盘记录
 */
export async function getRetrospective(orderId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: retrospective, error } = await supabase
    .from('order_retrospectives')
    .select('*')
    .eq('order_id', orderId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    return { error: error.message };
  }
  
  return { data: retrospective || null };
}
