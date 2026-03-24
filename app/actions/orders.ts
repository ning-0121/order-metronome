'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { MILESTONE_TEMPLATE_V1, getApplicableMilestones } from '@/lib/milestoneTemplate';
import { calcDueDates } from '@/lib/schedule';
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
export async function createOrder(formData: FormData, preGeneratedOrderNo?: string) {
  const supabase = await createClient();
  
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  // Validate email domain
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }
  
  // ⚠️ 系统级约束：order_no 必须由系统预生成
  if (!preGeneratedOrderNo) {
    return { error: '订单号需由系统预生成，请刷新页面重试' };
  }
  
  // ⚠️ 系统级约束：禁止从 formData 读取 order_no（即使存在也会被忽略）
  const customer_name = formData.get('customer_name') as string;
  const customer_id = formData.get('customer_id') as string;
  if (!customer_id) {
    return { error: '请选择客户' };
  }
  const incoterm = formData.get('incoterm') as IncotermType;
  const etd = formData.get('etd') as string | null;
  const warehouse_due_date = formData.get('warehouse_due_date') as string | null;
  const order_type = formData.get('order_type') as OrderType;
  const packaging_type = formData.get('packaging_type') as PackagingType;
  // PO 容器模型新增字段
  const customer_po_number = formData.get('customer_po_number') as string | null;
  const order_date = formData.get('order_date') as string | null;
  const total_quantity = formData.get('total_quantity') ? parseInt(formData.get('total_quantity') as string, 10) : null;
  const style_count = formData.get('style_count') ? parseInt(formData.get('style_count') as string, 10) : null;
  const eta = formData.get('eta') as string | null;
  const shipping_sample_required = formData.get('shipping_sample_required') === 'true';
  const shipping_sample_deadline = formData.get('shipping_sample_deadline') as string | null;
  const shipment_basis = incoterm === 'FOB' ? 'shipment' : 'arrival';
  // 风险标记
  const has_plus_size = formData.get('has_plus_size') === 'true';
  const high_stretch = formData.get('high_stretch') === 'true';
  const light_color_risk = formData.get('light_color_risk') === 'true';
  const complex_print = formData.get('complex_print') === 'true';
  const new_customer = formData.get('new_customer') === 'true';
  const style_no = formData.get('style_no') as string | null;
  const po_number = formData.get('po_number') as string | null;
  const quantity = formData.get('quantity') ? parseInt(formData.get('quantity') as string, 10) : null;
  const cancel_date = formData.get('cancel_date') as string | null;
  
  // Validate incoterm-specific dates
  if (incoterm === 'FOB' && !etd) {
    return { error: 'FOB 贸易条款需填写预计离港日期（ETD）' };
  }
  if (incoterm === 'DDP' && !warehouse_due_date) {
    return { error: 'DDP 贸易条款需填写仓库截止日期' };
  }
  
  // Create order (使用 repository，传入预生成的订单号)
  const insertPayload: any = {
    // ⚠️ 系统级约束：order_no 不在 payload 中，由 repository 层自动生成
    customer_name,
    customer_id,
    owner_user_id: user.id,
    incoterm,
    etd: etd || null,
    warehouse_due_date: warehouse_due_date || null,
    order_type,
    packaging_type,
    style_no: style_no || null,
    po_number: po_number || null,
    quantity: quantity || null,
    cancel_date: cancel_date || null,
    customer_po_number: customer_po_number || null,
    order_date: order_date || null,
    total_quantity: total_quantity || null,
    style_count: style_count || null,
    eta: eta || null,
    shipment_basis,
    shipping_sample_required,
    shipping_sample_deadline: shipping_sample_deadline || null,
    has_plus_size,
    high_stretch,
    light_color_risk,
    complex_print,
    new_customer,
    created_by: user.id,
  };
  
  // ⚠️ 系统级约束：使用预生成的订单号创建订单
  const { data: order, error: orderError } = await createOrderRepo(insertPayload, preGeneratedOrderNo);
  
  if (orderError || !order) {
    return { error: orderError || '订单创建失败，请重试' };
  }
  
  const orderData = order as any;
  
  // ⚠️ 使用 V1 托底闭环里程碑模板生成所有18个里程碑
  const createdAt = new Date(orderData.created_at);
  
  // 计算所有里程碑的 due_at
  const dueDates = calcDueDates({
    orderDate: order_date,
    createdAt: new Date(orderData.created_at),
    incoterm: orderData.incoterm as 'FOB' | 'DDP',
    etd: orderData.etd,
    warehouseDueDate: orderData.warehouse_due_date,
    eta: orderData.eta,
    orderType: (orderData.order_type as 'sample' | 'bulk' | 'repeat') || 'bulk',
    shippingSampleRequired: orderData.shipping_sample_required || false,
    shippingSampleDeadline: orderData.shipping_sample_deadline,
  })
  
  // 生成里程碑数据：使用 milestoneTemplate 和 calcDueDates
  const milestonesData = getApplicableMilestones(orderData.order_type, orderData.shipping_sample_required).map((template, index) => {
    const dueAt = dueDates[template.step_key as keyof typeof dueDates];
    if (!dueAt) {
      throw new Error(`Missing due date calculation for step_key: ${template.step_key}`);
    }
    
    // planned_at can equal due_at for V1 (per user requirement)
    const plannedAt = dueAt;
    
    // 状态：第一个里程碑（po_confirmed）为 in_progress，其他为 pending (not_started)
    const status = index === 0 ? '进行中' : '未开始';
    
    return {
      step_key: template.step_key,
      name: template.name,
      owner_role: template.owner_role,
      owner_user_id: null,
      planned_at: ensureBusinessDay(plannedAt).toISOString(),
      due_at: ensureBusinessDay(dueAt).toISOString(),
      status: status,
      is_critical: template.is_critical,
      evidence_required: template.evidence_required,
      evidence_note: (template as any).evidence_note || null,
      blocks: (template as any).blocks || [],
      notes: null,
      sequence_number: index + 1,
    };
  });
  
  // ⚠️ 系统级初始化：通过 RPC 调用数据库函数（SECURITY DEFINER 绕过 RLS）
  const { error: rpcError } = await (supabase.rpc as any)('init_order_milestones', {
    _order_id: orderData.id,
    _milestones_data: milestonesData,
  });
  
  if (rpcError) {
    // Rollback order creation (使用 repository)
    await deleteOrder(orderData.id);
    return { error: `执行节点初始化失败：${rpcError.message}` };
  }
  
  // ── 文件上传到 Supabase Storage ──
  // 创建订单时只需上传客户PO（必传）
  // 生产单：由财务审核后节点凭证上传（order_docs_bom_complete 节点）
  // 包装资料：后期在包装前上传（可选）
  const fileFields: Array<{ formKey: string; fileType: string; required: boolean }> = [
    { formKey: 'customer_po_file', fileType: 'customer_po', required: true },
    { formKey: 'packaging_material_file', fileType: 'packaging_material', required: false },
  ];

  for (const { formKey, fileType, required } of fileFields) {
    const file = formData.get(formKey) as File | null;
    if (!file || file.size === 0) {
      if (required) {
        await deleteOrder(orderData.id);
        return { error: '请上传客户 PO 文件' };
      }
      continue;
    }
    const ext = file.name.split('.').pop() || 'bin';
    const storagePath = orderData.id + '/' + fileType + '_' + Date.now() + '.' + ext;
    const { error: uploadError } = await supabase.storage
      .from('order-docs')
      .upload(storagePath, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      console.error('[createOrder] file upload error:', uploadError.message);
      continue;
    }
    await supabase.from('order_files').insert({
      order_id: orderData.id,
      file_type: fileType,
      storage_path: storagePath,
      original_filename: file.name,
      file_size_bytes: file.size,
      uploaded_by: user.id,
    });
  }

  revalidatePath('/orders');
  revalidatePath('/dashboard');
  
  return { data: order };
}

export async function getOrders() {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, incoterm, etd, warehouse_due_date, order_type, packaging_type, notes, created_at, style_no, po_number, quantity, cancel_date')
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
  
  const { data: logs, error } = await supabase
    .from('order_logs')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: logs };
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
