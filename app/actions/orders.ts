'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
// 动态导入：避免模块初始化顺序问题（修复 Cannot access '_' before initialization）
// import { MILESTONE_TEMPLATE_V1, getApplicableMilestones } from '@/lib/milestoneTemplate';
// import { calcDueDates, recalcRemainingDueDates } from '@/lib/schedule';
// import { subtractWorkingDays, ensureBusinessDay } from '@/lib/utils/date';
// 2026-04-15：把 ordersRepo 也纳入动态导入 — 修复进行中订单 Cannot access 'ac' before initialization
// 其它外部入口（preGenerateOrderNo / activateOrderAction 等）继续静态导入，只在 createOrder 函数内部用动态
import {
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
 *
 * TODO(Sprint-1): 迁移到 ActionResult<{ orderId: string; warning?: string }>。
 *   现状：665 行，多 return 点，副作用包括 milestone 生成、邮件、AI 抽取、附件移交。
 *   迁移路径：先抽 Core 函数返回 ActionResult，再用 toLegacyResult/toLegacyOkResult 包装。
 *   调用方：app/orders/new/page.tsx:576（期望 result.ok / result.error / result.orderId）
 */
export async function createOrder(
  formData: FormData,
  preGeneratedOrderNo?: string
): Promise<{ ok: boolean; orderId?: string; error?: string; warning?: string }> {
  try { // 全局 try-catch：防止未处理异常导致"Server Components render"
  // 动态导入（避免模块初始化顺序问题 — 历次遇到 Cannot access 'X' before initialization 都是静态导入链路里出问题）
  const { MILESTONE_TEMPLATE_V1, getApplicableMilestones } = await import('@/lib/milestoneTemplate');
  const { calcDueDates, recalcRemainingDueDates } = await import('@/lib/schedule');
  const { subtractWorkingDays, ensureBusinessDay } = await import('@/lib/utils/date');
  const { createOrder: createOrderRepo, deleteOrder } = await import('@/lib/repositories/ordersRepo');
  console.log('[createOrder] START — imports OK, preGeneratedOrderNo:', preGeneratedOrderNo);
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

  // 交付方式
  const deliveryTypeRaw = formData.get('delivery_type') as string | null;
  const delivery_type = deliveryTypeRaw || (['RMB_EX_TAX', 'RMB_INC_TAX'].includes(incoterm) ? 'domestic' : 'export');

  // 订单用途（production 或 sample）
  const order_purpose = formData.get('order_purpose') as string || 'production';

  const order_type = formData.get('order_type') as OrderType;
  if (!order_type) return { ok: false, error: '请选择订单类型' };

  const etd = formData.get('etd') as string | null;
  const warehouse_due_date = formData.get('warehouse_due_date') as string | null;
  const order_date = formData.get('order_date') as string | null;
  const cancel_date = formData.get('cancel_date') as string | null;
  const factory_date = formData.get('factory_date') as string | null;
  const eta = formData.get('eta') as string | null;
  const customer_email = formData.get('customer_email') as string | null;
  // ⚠️ 必须在 line 171 校验之前提取（否则 const TDZ → Cannot access 'xx' before initialization）
  const po_number = formData.get('customer_po_number') as string | null;
  const internal_order_no = formData.get('internal_order_no') as string | null;
  // 翻单回顾
  const repeat_prev_order_no = formData.get('repeat_prev_order_no') as string | null;
  const repeat_issues = formData.get('repeat_issues') as string | null;
  const repeat_attention = formData.get('repeat_attention') as string | null;
  const shipping_sample_required = formData.get('shipping_sample_required') === 'true';
  const shipping_sample_deadline = formData.get('shipping_sample_deadline') as string | null;
  const factory_name = formData.get('factory_name') as string | null;
  const factory_id = formData.get('factory_id') as string | null;

  // 多工厂（分厂区生产）— 客户端以 JSON 字符串数组写入
  let factory_ids: string[] | null = null;
  let factory_names: string[] | null = null;
  try {
    const idsRaw = formData.get('factory_ids') as string | null;
    const namesRaw = formData.get('factory_names') as string | null;
    if (idsRaw) {
      const parsed = JSON.parse(idsRaw);
      if (Array.isArray(parsed) && parsed.length > 0) factory_ids = parsed;
    }
    if (namesRaw) {
      const parsed = JSON.parse(namesRaw);
      if (Array.isArray(parsed) && parsed.length > 0) factory_names = parsed;
    }
  } catch {}

  // 样品阶段（新）+ 兼容旧 checkbox
  const sample_phase_raw = formData.get('sample_phase') as string | null;
  const validPhases = ['confirmed', 'dev_sample', 'dev_sample_with_revision', 'skip_all'];
  const sample_phase = (sample_phase_raw && validPhases.includes(sample_phase_raw))
    ? sample_phase_raw
    : undefined;
  // 兼容旧表单的 checkbox（如果有 sample_phase 则忽略旧字段）
  const skip_pre_production_sample = sample_phase
    ? sample_phase === 'skip_all'
    : formData.get('skip_pre_production_sample') === 'true';
  const sampleConfirmRaw = formData.get('sample_confirm_days_override') as string | null;
  const sample_confirm_days_override = sampleConfirmRaw ? parseInt(sampleConfirmRaw, 10) : null;
  const totalQuantity = formData.get('total_quantity') as string | null;
  const quantityUnit = formData.get('quantity_unit') as string || '件';
  // 统一按件数存储：套 = 数量 × 2
  const rawQty = totalQuantity ? parseInt(totalQuantity, 10) : null;
  const quantity = rawQty && quantityUnit === '套' ? rawQty * 2 : rawQty;
  const styleCount = formData.get('style_count') as string | null;
  const colorCount = formData.get('color_count') as string | null;

  if (!internal_order_no?.trim()) return { ok: false, error: '请填写内部订单号（订单册编号），财务需要此编号进行核算' };
  if (!etd && incoterm === 'DDP') return { ok: false, error: 'DDP 条款请填写 ETD（离港日）' };
  if (!warehouse_due_date && incoterm === 'DDP') return { ok: false, error: 'DDP 条款请填写 ETA（到港/到仓日）' };
  if (!factory_date) return { ok: false, error: '请填写出厂日期' };
  if (!quantity) return { ok: false, error: '请填写预估总数量' };
  if (!styleCount) return { ok: false, error: '请填写款数' };
  if (!colorCount) return { ok: false, error: '请填写颜色数' };

  // ── 日期合理性校验 ──
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const orderDt = order_date ? new Date(order_date) : today;
  const factoryDt = new Date(factory_date);

  // 出厂日期不能是过去的离谱日期
  if (factoryDt < new Date('2020-01-01')) {
    return { ok: false, error: `出厂日期 ${factory_date} 明显不对，请检查` };
  }

  // 出厂日期必须在下单日期之后
  if (factoryDt < orderDt) {
    return { ok: false, error: `出厂日期（${factory_date}）不能早于下单日期（${order_date}）` };
  }

  // 下单到出厂最少7天（面料采购+生产需要时间）
  const daysToFactory = Math.ceil((factoryDt.getTime() - orderDt.getTime()) / 86400000);
  if (daysToFactory < 7) {
    return { ok: false, error: `下单日到出厂日仅 ${daysToFactory} 天，最少需要 7 天（含采购和生产时间）。如确实是加急单请选择"加急订单"类型。` };
  }

  // DDP: ETD 必须在出厂日期之后
  if (etd && factory_date) {
    if (new Date(etd) < factoryDt) {
      return { ok: false, error: `ETD（${etd}）不能早于出厂日期（${factory_date}）` };
    }
  }

  // DDP: ETA 必须在 ETD 之后
  if (etd && warehouse_due_date) {
    if (new Date(warehouse_due_date) <= new Date(etd)) {
      return { ok: false, error: `ETA（${warehouse_due_date}）必须晚于 ETD（${etd}）` };
    }
  }

  // Cancel date 必须在出厂日期之后
  if (cancel_date && factory_date) {
    if (new Date(cancel_date) < factoryDt) {
      return { ok: false, error: `Cancel Date（${cancel_date}）不能早于出厂日期（${factory_date}）` };
    }
  }
  // ── 价格审批闸门校验（CEO 强制规则） ──
  // 1) 如果业务员持有 price_approval_id，必须验证它有效（防止伪造 ID）
  // 2) 如果该客户+PO 有 24h 内的 pending 价格审批且未提供 ID，禁止创建（防止绕过审批）
  //    注意：不限制 requested_by — 防止 A 业务员创建审批、B 绕过的攻击
  const priceApprovalId = formData.get('price_approval_id') as string | null;
  let validatedApprovalId: string | null = null;
  if (priceApprovalId) {
    const { validatePriceApproval } = await import('./price-approvals');
    const result = await validatePriceApproval(priceApprovalId, user.id);
    if (!result.valid) {
      return { ok: false, error: `价格审批校验失败：${result.error}` };
    }
    validatedApprovalId = priceApprovalId;
  } else if (po_number && customer_name) {
    // 没传 ID 时，检查同客户+同 PO 是否有任何人的 pending 申请
    const { data: pending } = await (supabase.from('pre_order_price_approvals') as any)
      .select('id, status, expires_at, requested_by')
      .eq('customer_name', customer_name)
      .eq('po_number', po_number)
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .limit(1);
    if (pending && pending.length > 0) {
      return {
        ok: false,
        error:
          `⚠️ 该客户+PO 有待 CEO 审批的价格申请（ID: ${pending[0].id.slice(0, 8)}...），` +
          `请等待 CEO 在「价格审批」页面批准后，再回到表单点「✓ CEO 已批准，继续创建」。`,
      };
    }
  }

  // ── 重复订单检测：同客户+同PO号+同数量 ──
  if (po_number && quantity && customer_name) {
    const { data: duplicates } = await (supabase.from('orders') as any)
      .select('id, order_no')
      .eq('customer_name', customer_name)
      .eq('po_number', po_number)
      .eq('quantity', quantity)
      .limit(1);
    if (duplicates && duplicates.length > 0) {
      const skipDupCheck = formData.get('confirm_duplicate') === 'true';
      if (!skipDupCheck) {
        return { ok: false, orderId: undefined, error: `⚠️ 疑似重复订单：已存在相同客户（${customer_name}）+ 相同PO号（${po_number}）+ 相同数量（${quantity}件）的订单 ${duplicates[0].order_no}。如确认不是重复，请重新提交。`, warning: 'duplicate' };
      }
    }
  }

  // ── STEP 3: insert order — 写入订单到数据库 ──
  const dbOrderType = order_type || 'bulk';

  // 首单自动识别 + 手动覆盖
  // 翻单(repeat)类型的客户/工厂一定不是首单，跳过自动检测
  const manualNewCustomer = formData.get('new_customer') === 'true';
  const manualNewFactory = formData.get('new_factory') === 'true';
  let isNewCustomer = manualNewCustomer;
  let isNewFactory = manualNewFactory;
  if (dbOrderType === 'repeat') {
    // 翻单 = 老客户老工厂，不标首单
    isNewCustomer = false;
    isNewFactory = false;
  } else {
    // 自动检测：查该客户/工厂历史订单数（含导入的历史订单）
    if (customer_id && !manualNewCustomer) {
      const { count } = await (supabase.from('orders') as any).select('id', { count: 'exact', head: true }).eq('customer_id', customer_id);
      if (count === 0) isNewCustomer = true;
    }
    if (factory_id && !manualNewFactory) {
      const { count } = await (supabase.from('orders') as any).select('id', { count: 'exact', head: true }).eq('factory_id', factory_id);
      if (count === 0) isNewFactory = true;
    }
  }

  const insertPayload: Record<string, any> = {
    customer_name,
    customer_id,
    ...(customer_email ? { customer_email } : {}),
    po_number: po_number || null,
    internal_order_no: internal_order_no || null,
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
    factory_ids: factory_ids,
    factory_names: factory_names,
    price_approval_id: validatedApprovalId,
    skip_pre_production_sample: skip_pre_production_sample,
    ...(sample_phase ? { sample_phase } : {}),
    sample_confirm_days_override: sample_confirm_days_override && !isNaN(sample_confirm_days_override)
      ? sample_confirm_days_override
      : null,
    is_new_customer: isNewCustomer,
    is_new_factory: isNewFactory,
    created_by: user.id,
    quantity: quantity,
    quantity_unit: quantityUnit,
    style_count: styleCount ? parseInt(styleCount, 10) : null,
    color_count: colorCount ? parseInt(colorCount, 10) : null,
    factory_date: factory_date || null,
    eta: eta || warehouse_due_date || null,
    delivery_type,
    order_purpose,
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

  console.log('[createOrder] STAGE: before STEP 3 createOrderRepo');
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

  console.log('[createOrder] STAGE: before STEP 4 calcDueDates');
  // ── STEP 4: create milestones — 计算排期 ──
  let dueDates: Record<string, Date>;
  try {
    // RMB不含税/RMB含税/FOB: 锚点=出厂日期（etd fallback factory_date）
    // DDP: 锚点=ETA-25天海运
    const scheduleIncoterm = incoterm === 'DDP' ? 'DDP' : 'FOB';
    const scheduleEtd = etd || factory_date; // 非DDP用出厂日期作为锚点

    if (!scheduleEtd) {
      await deleteOrder(orderData.id);
      return { ok: false, error: '排期计算错误：缺少锚点日期。人民币/FOB订单需填出厂日期，DDP需填ETD。' };
    }

    // 查询客户节奏偏好（如 RAG 要求离厂前 1 天寄船样）
    let customerScheduleOverrides: any = {};
    try {
      const { getOverridesForCustomer } = await import('@/app/actions/customer-schedules');
      customerScheduleOverrides = await getOverridesForCustomer(customer_name);
      if (Object.keys(customerScheduleOverrides).length > 0) {
        console.log(`[createOrder] applied ${Object.keys(customerScheduleOverrides).length} customer schedule overrides for ${customer_name}`);
      }
    } catch (e) {
      console.warn('[createOrder] failed to load customer schedule overrides:', e);
    }

    dueDates = calcDueDates({
      orderDate: order_date,
      createdAt: new Date(orderData.created_at),
      incoterm: scheduleIncoterm as 'FOB' | 'DDP',
      etd: scheduleEtd,
      warehouseDueDate: warehouse_due_date,
      eta: eta,
      orderType: (order_type as 'sample' | 'bulk' | 'repeat') || 'bulk',
      shippingSampleRequired: shipping_sample_required,
      shippingSampleDeadline: shipping_sample_deadline,
      sampleConfirmDaysOverride: sample_confirm_days_override,
      skipPreProductionSample: skip_pre_production_sample,
      customerScheduleOverrides,
    });
  } catch (scheduleErr: any) {
    console.error('[createOrder] STEP 4 FAIL: calcDueDates —', scheduleErr.message);
    await deleteOrder(orderData.id);
    return { ok: false, error: `排期计算失败：${scheduleErr.message}` };
  }

  // 角色映射：确保模板角色值 → DB 合法值
  // ⚠️ 注意：此处必须列全所有 OwnerRole 值，漏掉任何一个都会 fallback 到 'sales'，
  //    导致节点错误分配给下单人（已知 bug：production_manager 曾经漏掉）
  const ROLE_TO_DB: Record<string, string> = {
    sales: 'sales',
    finance: 'finance',
    procurement: 'procurement',
    production: 'production',
    production_manager: 'production_manager', // ← 修复：之前缺失导致生产主管节点 fallback 到 sales
    qc: 'qc',
    logistics: 'logistics',
    admin: 'admin',
    admin_assistant: 'admin_assistant',
    merchandiser: 'merchandiser',
    quality: 'qc',
  };

  // ── 自动分配：查询各角色的默认负责人 ──
  // 优先级 1: DEFAULT_ASSIGNEES 配置（财务=方圆，采购=Helen，生产主管=秦增富）
  // 优先级 2: 角色匹配且全公司只有一个用户 → 自动分配
  const roleUserMap: Record<string, string | null> = { sales: user.id };
  // 固定由生产主管负责的 step_key → user_id 映射
  const fixedStepOwnerMap: Record<string, string> = {};
  try {
    const { DEFAULT_ASSIGNEES, findAssigneeUserId, PRODUCTION_MANAGER_FIXED_STEPS } = await import('@/lib/domain/default-assignees');
    const { data: allProfiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email, role, roles');

    if (allProfiles) {
      // 先匹配生产主管（用于固定步骤）
      for (const roleToFind of ['procurement', 'finance', 'logistics', 'production_manager']) {
        const matcher = (DEFAULT_ASSIGNEES as any)[roleToFind];
        if (matcher) {
          const userId = findAssigneeUserId(allProfiles as any, matcher);
          if (userId) {
            roleUserMap[roleToFind] = userId;
            continue;
          }
        }
        // 兜底：该角色全公司只有一个人 → 用 ta
        const matched = (allProfiles as any[]).filter((p: any) => {
          const r: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
          return r.includes(roleToFind);
        });
        if (matched.length === 1) {
          roleUserMap[roleToFind] = matched[0].user_id;
        }
      }
      // 生产主管固定步骤映射
      const pmUserId = roleUserMap['production_manager'];
      if (pmUserId && PRODUCTION_MANAGER_FIXED_STEPS) {
        for (const stepKey of PRODUCTION_MANAGER_FIXED_STEPS) {
          fixedStepOwnerMap[stepKey] = pmUserId;
        }
      }
    }
  } catch (assignErr: any) {
    console.error('[createOrder] auto-assign error:', assignErr?.message);
  } // 查询失败不影响订单创建

  console.log('[createOrder] STAGE: before getApplicableMilestones');
  const templates = getApplicableMilestones(
    order_type,
    shipping_sample_required,
    delivery_type,
    order_purpose,
    skip_pre_production_sample,
    sample_phase,
  );
  // 防御性下限：任何节点 due_at 不能早于下单日（T0），
  // 否则 ensureBusinessDay 遇到连续节假日可能越界回退（历史 bug 防护）
  const T0Floor = order_date
    ? new Date(order_date + 'T00:00:00+08:00')
    : new Date(orderData.created_at);
  const clampNotBeforeT0 = (d: Date): Date =>
    d.getTime() < T0Floor.getTime() ? new Date(T0Floor) : d;

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
    // 自动分配优先级：
    //   1. 生产主管固定步骤（factory_confirmed / pre_production_sample_ready → 秦增富）
    //   2. DEFAULT_ASSIGNEES（财务=方圆，采购=Helen）
    //   3. 角色唯一用户
    //   4. null（待管理员手动指定）
    const autoAssign = fixedStepOwnerMap[template.step_key] || roleUserMap[dbRole] || null;
    const safeDue = clampNotBeforeT0(ensureBusinessDay(dueAt));
    milestonesData.push({
      step_key: template.step_key,
      name: template.name,
      owner_role: dbRole,
      owner_user_id: autoAssign,
      planned_at: safeDue.toISOString(),
      due_at: safeDue.toISOString(),
      status: index === 0 ? 'in_progress' : 'pending',
      is_critical: template.is_critical,
      evidence_required: template.evidence_required,
      evidence_note: (template as any).evidence_note || null,
      blocks: (template as any).blocks || [],
      notes: null,
      sequence_number: index + 1,
    });
  }
  console.log('[createOrder] STAGE: before STEP 5 init_order_milestones RPC');
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
  // ── STEP 5b: 跟单未指定 → 立即通知生产主管 ──
  // CEO 2026-04-09：新订单如果没有指定跟单就要提醒生产主管
  try {
    const hasUnassignedMerch = milestonesData.some(
      m => m.owner_role === 'merchandiser' && !m.owner_user_id,
    );
    if (hasUnassignedMerch) {
      const pmUserId = roleUserMap['production_manager'];
      if (pmUserId) {
        await (supabase.from('notifications') as any).insert({
          user_id: pmUserId,
          type: 'unassigned_merchandiser',
          title: `📋 新订单 ${orderData.order_no} 还没有指定跟单`,
          message: `客户：${customer_name || '?'} · 数量：${quantity || '?'} 件\n请尽快在订单详情页指定跟单人员。`,
          related_order_id: orderData.id,
          status: 'unread',
        });
        // 微信推送
        try {
          const { pushToUsers } = await import('@/lib/utils/wechat-push');
          await pushToUsers(supabase, [pmUserId],
            `📋 新订单 ${orderData.order_no} 未指定跟单`,
            `客户 ${customer_name || '?'}，${quantity || '?'} 件\n请尽快指定跟单人员`
          );
        } catch {}
      }
    }
  } catch (notifErr: any) {
    console.warn('[createOrder] 通知生产主管失败（不影响订单创建）:', notifErr?.message);
  }

  // ── STEP 6: 历史导入模式处理 ──
  // CEO 2026-04-09：进行中订单创建需要 CEO 审批
  // → lifecycle_status 设为 'pending_approval'，不自动激活
  // → 通知 CEO，等审批通过后再变 active
  const isImport = formData.get('is_import') === 'true';
  const importCurrentStep = formData.get('import_current_step') as string | null;
  const importReason = formData.get('import_reason') as string | null;

  if (isImport && importCurrentStep) {
    console.log('[createOrder] STAGE: STEP 6 isImport branch, step=', importCurrentStep);
    try {
      // 6a. 标记为待审批（不直接激活）
      await (supabase.from('orders') as any)
        .update({
          imported_at: new Date().toISOString(),
          import_current_step: importCurrentStep,
          lifecycle_status: 'pending_approval',
          notes: importReason
            ? `[进行中导入] ${importReason}\n${orderData.notes || ''}`
            : orderData.notes || null,
        })
        .eq('id', orderData.id);

      // 6a2. 通知所有 admin — 等审批
      try {
        const { data: admins } = await (supabase.from('profiles') as any)
          .select('user_id')
          .or('role.eq.admin,roles.cs.{admin}');
        const { data: creatorProfile } = await (supabase.from('profiles') as any)
          .select('name, email').eq('user_id', user.id).single();
        const creatorName = (creatorProfile as any)?.name || user.email?.split('@')[0] || '?';
        for (const admin of (admins || []) as any[]) {
          await (supabase.from('notifications') as any).insert({
            user_id: admin.user_id,
            type: 'import_order_approval',
            title: `📋 进行中订单待审批 — ${orderData.order_no}`,
            message: `${creatorName} 创建了一个进行中导入订单：\n客户 ${customer_name || '?'} · ${quantity || '?'} 件\n当前阶段：${importCurrentStep}\n原因：${importReason || '未填'}\n\n请到订单详情页审批。`,
            related_order_id: orderData.id,
            status: 'unread',
          });
        }
        // 微信推送 admin
        const adminIds = ((admins || []) as any[]).map(a => a.user_id);
        if (adminIds.length > 0) {
          const { pushToUsers } = await import('@/lib/utils/wechat-push');
          await pushToUsers(supabase, adminIds,
            `📋 待审批：${orderData.order_no} 进行中导入`,
            `${creatorName} 导入订单，客户 ${customer_name || '?'}，${quantity || '?'} 件\n原因：${importReason || '未填'}`
          ).catch(() => {});
        }
      } catch {}

      // 6b: 不做后续的里程碑激活！等 CEO 审批通过后由 approveImportOrder 处理
      // ↓ 直接跳过原来的 6b-6e 代码
      revalidatePath('/orders');
      return {
        ok: true,
        orderId: orderData.id,
        warning: 'pending_approval',
        error: `订单 ${orderData.order_no} 已提交，等待 CEO 审批。`,
      };
    } catch (importErr: any) {
      console.warn('[createOrder] 导入模式处理失败:', importErr.message);
    }
  }

  // 旧的 import 激活逻辑已移到 approveImportOrder（ceo 审批通过后激活），
  // 此处原来的 if(false) 死代码块已清理（含 templates / recalcRemainingDueDates 引用，
  // 可能被打包器静态分析误处理，疑似 TDZ 原因）

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
      });
    }
  } catch {} // 通知失败不阻断订单创建

  // ── 推送到财务系统 ──
  try {
    const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
    await syncOrderToFinance(orderData, 'order.created');
  } catch {} // 财务推送失败不阻断订单创建

  // ── STEP 7: 初始化经营数据 + 确认链 ──
  try {
    const { initOrderFinancials } = await import('@/app/actions/order-financials');
    await initOrderFinancials(orderData.id);
  } catch {} // 初始化失败不阻断订单创建

  // ── STEP 8: 翻单回顾存入客户画像 ──
  if (order_type === 'repeat' && repeat_issues) {
    try {
      const content = [
        `翻单回顾（上一单：${repeat_prev_order_no || '未填写'}）`,
        `问题：${repeat_issues}`,
        repeat_attention ? `注意事项：${repeat_attention}` : null,
      ].filter(Boolean).join('\n');

      // 存入客户画像
      await (supabase.from('customer_memory') as any).insert({
        customer_id: customer_name,
        order_id: orderData.id,
        source_type: 'repeat_order_review',
        content,
        category: 'quality',
        risk_level: 'medium',
        created_by: user.id,
      });

      // 同步写入订单备注，方便在订单详情里直接看到
      if (orderData.notes) {
        await (supabase.from('orders') as any)
          .update({ notes: `${orderData.notes}\n\n【翻单回顾】${content}` })
          .eq('id', orderData.id);
      } else {
        await (supabase.from('orders') as any)
          .update({ notes: `【翻单回顾】${content}` })
          .eq('id', orderData.id);
      }
    } catch {} // 回顾存储失败不阻断订单创建
  }

  // ── STEP 9: 交期已过订单处理 ──
  const pastDateStatus = formData.get('past_date_status') as string | null;
  const pastDateReason = formData.get('past_date_reason') as string | null;
  if (pastDateStatus) {
    try {
      if (pastDateStatus === 'shipped') {
        // 已发货：标记所有节点完成 + 订单完成
        const now = new Date().toISOString();
        await (supabase.from('milestones') as any)
          .update({ status: 'done', actual_at: now })
          .eq('order_id', orderData.id);
        await (supabase.from('orders') as any)
          .update({ lifecycle_status: 'completed', notes: (orderData.notes || '') + '\n\n【补录】已发货订单，系统自动标记完成' })
          .eq('id', orderData.id);
      } else if (pastDateStatus === 'problem') {
        // 有问题：记录原因到订单备注 + 标记为 blocked
        await (supabase.from('orders') as any)
          .update({
            lifecycle_status: 'active',
            notes: (orderData.notes || '') + `\n\n【交期已过未发货】原因：${pastDateReason || '未说明'}`,
            special_tags: [...(orderData.special_tags || []), '交期逾期'],
          })
          .eq('id', orderData.id);
      } else {
        // pending（在途）：正常激活
        await (supabase.from('orders') as any)
          .update({ lifecycle_status: 'active' })
          .eq('id', orderData.id);
      }
    } catch {} // 处理失败不阻断
  }

  // ── DONE ──
  revalidatePath('/orders');
  revalidatePath('/dashboard');
  return { ok: true, orderId: orderData.id };
  } catch (globalErr: any) {
    console.error('[createOrder] 全局异常:', globalErr?.message, globalErr?.stack);
    return { ok: false, error: `创建订单失败：${globalErr?.message || '未知错误'}` };
  }
}

export async function getOrders() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // 判断是否管理员
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');

  // 管理员/财务/行政/生产主管看全部订单
  const canSeeAll = isAdmin || roles.some((r: string) => ['finance', 'admin_assistant', 'production_manager'].includes(r));

  // 辅助：把 delay_requests 按 order_id 分组合并进 orders
  async function attachDelayRequests(orderList: any[]): Promise<any[]> {
    if (!orderList || orderList.length === 0) return orderList;
    const orderIds = orderList.map((o: any) => o.id);
    const { data: delayRows } = await (supabase.from('delay_requests') as any)
      .select('id, order_id, status, proposed_new_anchor_date, created_at')
      .in('order_id', orderIds);
    const delayMap: Record<string, any[]> = {};
    for (const d of (delayRows || [])) {
      if (!delayMap[d.order_id]) delayMap[d.order_id] = [];
      delayMap[d.order_id].push(d);
    }
    return orderList.map((o: any) => ({ ...o, delay_requests: delayMap[o.id] || [] }));
  }

  if (canSeeAll) {
    const { data: orders, error } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, factory_name, factory_id, incoterm, etd, warehouse_due_date, lifecycle_status, order_type, packaging_type, notes, created_at, style_no, po_number, internal_order_no, quantity, cancel_date, order_date, factory_date, special_tags, owner_user_id, created_by, milestones(id, name, step_key, status, due_at, actual_at, owner_role, owner_user_id, sequence_number)')
      .order('created_at', { ascending: false });
    if (error) return { error: error.message };
    // 解析跟单和业务员名称
    const userIds = new Set<string>();
    for (const o of (orders || []) as any[]) {
      if (o.owner_user_id) userIds.add(o.owner_user_id);
      if (o.created_by) userIds.add(o.created_by);
      // 从 milestones 里找跟单负责人
      for (const m of (o.milestones || [])) {
        if (m.owner_user_id) userIds.add(m.owner_user_id);
      }
    }
    let nameMap: Record<string, string> = {};
    if (userIds.size > 0) {
      const { data: profiles } = await (supabase.from('profiles') as any)
        .select('user_id, name, email').in('user_id', Array.from(userIds));
      nameMap = (profiles || []).reduce((m: any, p: any) => {
        m[p.user_id] = p.name || p.email?.split('@')[0] || '';
        return m;
      }, {} as Record<string, string>);
    }
    const withNames = (orders || []).map((o: any) => {
      const merchMilestone = (o.milestones || []).find((m: any) =>
        m.owner_role === 'merchandiser' && m.owner_user_id
      );
      const merchUserId = merchMilestone?.owner_user_id;
      return {
        ...o,
        merchandiser_name: merchUserId ? nameMap[merchUserId] || null : null,
        sales_name: o.created_by ? nameMap[o.created_by] || null : null,
      };
    });
    const enriched = await attachDelayRequests(withNames);
    return { data: enriched };
  }

  // 普通员工：只看自己创建的 + 被分配了关卡的订单
  const { data: ownedOrders } = await (supabase.from('orders') as any)
    .select('id').eq('owner_user_id', user.id);
  const { data: assignedMilestones } = await (supabase.from('milestones') as any)
    .select('order_id').eq('owner_user_id', user.id);

  const myOrderIds = [...new Set([
    ...(ownedOrders || []).map((o: any) => o.id),
    ...(assignedMilestones || []).map((m: any) => m.order_id),
  ])];

  if (myOrderIds.length === 0) return { data: [] };

  const { data: orders, error } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_name, factory_id, incoterm, etd, warehouse_due_date, lifecycle_status, order_type, packaging_type, notes, created_at, style_no, po_number, internal_order_no, quantity, cancel_date, order_date, factory_date, special_tags, milestones(id, name, step_key, status, due_at, actual_at, owner_role, owner_user_id, sequence_number)')
    .in('id', myOrderIds)
    .order('created_at', { ascending: false });

  if (error) return { error: error.message };
  const enriched = await attachDelayRequests(orders || []);
  return { data: enriched };
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

  // 权限检查：订单创建者 / 跟单负责人 / 管理员
  const { data: existingOrder } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', id)
    .single();
  if (!existingOrder) {
    return { error: '订单不存在' };
  }
  const { isAdmin: isAdminUser } = await getCurrentUserRole(supabase);
  if (existingOrder.created_by !== user.id && existingOrder.owner_user_id !== user.id && !isAdminUser) {
    return { error: '无权修改此订单：仅订单创建者、跟单负责人或管理员可以修改' };
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
    const factory_date = formData.get('factory_date') as string | null;

    if (incoterm === 'DDP') {
      updates.etd = etd;
      updates.warehouse_due_date = warehouse_due_date;
      // 校验：ETA 必须晚于 ETD
      if (etd && warehouse_due_date && new Date(warehouse_due_date) <= new Date(etd)) {
        return { error: `ETA（${warehouse_due_date}）必须晚于 ETD（${etd}）` };
      }
      // 校验：ETD 必须晚于出厂日期
      if (etd && factory_date && new Date(etd) < new Date(factory_date)) {
        return { error: `ETD（${etd}）不能早于出厂日期（${factory_date}）` };
      }
    } else {
      // FOB: 只用 factory_date 作为锚点
      updates.etd = etd;
      updates.warehouse_due_date = null;
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

/**
 * 快捷更新订单单个字段（用于内联编辑）
 * 仅允许安全字段：internal_order_no, notes, style_no
 */
export async function updateOrderField(
  orderId: string,
  field: 'internal_order_no' | 'notes' | 'style_no',
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };

  const ALLOWED_FIELDS = ['internal_order_no', 'notes', 'style_no'];
  if (!ALLOWED_FIELDS.includes(field)) return { ok: false, error: '不允许修改此字段' };

  // 内部单号特殊规则：已有值时不允许修改（需要走财务审批）
  if (field === 'internal_order_no') {
    const { data: order } = await (supabase.from('orders') as any)
      .select('internal_order_no')
      .eq('id', orderId)
      .single();
    if (order?.internal_order_no) {
      // 检查是否是 admin/finance 角色
      const { data: profile } = await (supabase.from('profiles') as any)
        .select('role, roles')
        .eq('user_id', user.id)
        .single();
      const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
      // TODO(Sprint-1): ['admin','finance'] 不完全匹配 ROLE_GROUPS 任一组（最接近的 MANAGEMENT 多含 admin_assistant）
      //                 待评估后整合，本轮保留行为
      const canModify = roles.some(r => ['admin', 'finance'].includes(r));
      if (!canModify) {
        return { ok: false, error: '内部单号已填写，修改需要财务审批。请联系财务或管理员。' };
      }
    }
  }

  const { error } = await (supabase.from('orders') as any)
    .update({ [field]: value || null, updated_at: new Date().toISOString() })
    .eq('id', orderId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return { ok: true };
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

  // 权限检查：订单创建者 / 跟单负责人 (owner_user_id) / 管理员
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', orderId)
    .single();
  if (!order) {
    return { error: '订单不存在' };
  }
  const { isAdmin } = await getCurrentUserRole(supabase);
  const isCreator = order.created_by === user.id;
  const isCurrentOwner = order.owner_user_id === user.id;
  if (!isCreator && !isCurrentOwner && !isAdmin) {
    return { error: '无权操作此订单：仅订单创建者、跟单负责人或管理员可以操作' };
  }

  const result = await activateOrder(orderId);

  if (result.error) {
    return { error: result.error };
  }

  // 推送到财务系统
  try {
    const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
    if (result.data) await syncOrderToFinance(result.data as Record<string, unknown>, 'order.activated');
  } catch {}

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');

  return { data: result.data };
}

/**
 * 申请取消订单 — 仅创建者 / 跟单负责人 / 管理员
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

  // 权限校验：必须是订单创建者 / 跟单 / 管理员
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const isCreator = order.created_by === user.id;
  const isOwner = order.owner_user_id === user.id;
  if (!isAdmin && !isCreator && !isOwner) {
    return { error: '无权申请取消：仅订单创建者、跟单负责人或管理员可以操作' };
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
  
  // 推送到财务系统
  if (decision === 'approved') {
    try {
      const { notifyOrderCancelled } = await import('@/lib/integration/finance-sync');
      const cancelReq = result.data && typeof result.data === 'object' && 'cancelRequest' in result.data ? (result.data as any).cancelRequest : null;
      if (cancelReq) await notifyOrderCancelled({ id: cancelReq.order_id, lifecycle_status: '已取消' } as Record<string, unknown>);
    } catch {}
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

  // 推送到财务系统
  try {
    const { notifyOrderCompleted } = await import('@/lib/integration/finance-sync');
    if (result.data) await notifyOrderCompleted(result.data as Record<string, unknown>);
  } catch {}

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');

  return { data: result.data };
}

/**
 * CEO 审批进行中导入订单
 * — 把 pending_approval → active
 * — 激活里程碑（标记已过步骤为 done，当前步骤为 in_progress）
 */
export async function approveImportOrder(orderId: string): Promise<{ error?: string; data?: any }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // Sprint 1 / A：批准导入权限改为「仅财务」
  // 业务上由财务定夺成本/利润，再决定订单是否进入执行
  // admin 兜底：如财务暂离，临时给某账号加 finance role 即可，无需改代码
  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const isFinance = userRoles.includes('finance');
  if (!isFinance) return { error: '仅财务可审批进行中订单（如需变更，请联系系统管理员调整角色）' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, lifecycle_status, import_current_step, incoterm, etd, warehouse_due_date, eta')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };
  if (order.lifecycle_status !== 'pending_approval') {
    return { error: `订单状态不是"待审批"（当前：${order.lifecycle_status}）` };
  }

  const importCurrentStep = order.import_current_step;
  if (!importCurrentStep) return { error: '缺少导入当前步骤' };

  // 激活订单
  await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'active' })
    .eq('id', orderId);

  // 获取所有里程碑，标记已过步骤为 done，当前步骤为 in_progress
  const templates = (await import('@/lib/milestoneTemplate')).MILESTONE_TEMPLATE_V1;
  const currentIndex = templates.findIndex(t => t.step_key === importCurrentStep);

  if (currentIndex >= 0) {
    const { data: milestones } = await (supabase.from('milestones') as any)
      .select('id, step_key, sequence_number')
      .eq('order_id', orderId)
      .order('sequence_number', { ascending: true });

    if (milestones) {
      const currentSeq = currentIndex + 1;
      for (const ms of milestones as any[]) {
        const updates: any = {};
        if (ms.sequence_number < currentSeq) {
          updates.status = 'done';
          updates.actual_at = ms.due_at || new Date().toISOString();
        } else if (ms.sequence_number === currentSeq) {
          updates.status = 'in_progress';
        }
        if (Object.keys(updates).length > 0) {
          await (supabase.rpc as any)('admin_update_milestone', {
            _milestone_id: ms.id,
            _updates: updates,
          }).catch(() => {
            // 兜底直接 update
            (supabase.from('milestones') as any).update(updates).eq('id', ms.id);
          });
        }
      }
    }
  }

  // 通知创建者
  await (supabase.from('notifications') as any).insert({
    user_id: order.created_by || user.id,
    type: 'import_order_approved',
    title: `✅ 进行中订单已批准 — ${order.order_no}`,
    message: `CEO 已批准你的进行中导入订单，现在可以正常跟单了。`,
    related_order_id: orderId,
    status: 'unread',
  }).catch(() => {});

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return { data: { order_no: order.order_no } };
}

/**
 * CEO 拒绝进行中导入订单
 */
export async function rejectImportOrder(orderId: string, reason?: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可拒绝' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, created_by')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 标记为 rejected（不删除，保留记录）
  await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'cancelled', notes: `[CEO 拒绝] ${reason || '未说明原因'}` })
    .eq('id', orderId);

  // 通知创建者
  await (supabase.from('notifications') as any).insert({
    user_id: order.created_by,
    type: 'import_order_rejected',
    title: `❌ 进行中订单被拒绝 — ${order.order_no}`,
    message: `原因：${reason || '未说明'}\n如有疑问请联系 CEO。`,
    related_order_id: orderId,
    status: 'unread',
  }).catch(() => {});

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return {};
}

/**
 * CEO 强制标记订单为"已完成"
 * — 不要求所有里程碑完成，直接结案
 * — 未完成的里程碑批量标为 done
 * — 仅 admin 可操作
 */
export async function forceCompleteOrderAction(orderId: string): Promise<{ error?: string; data?: any }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可强制标记完成' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, lifecycle_status')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 批量把未完成节点标为 done
  const now = new Date().toISOString();
  await (supabase.from('milestones') as any)
    .update({ status: 'done', actual_at: now })
    .eq('order_id', orderId)
    .not('status', 'in', '("done","已完成","completed")');

  // 标记订单完成
  await (supabase.from('orders') as any)
    .update({ lifecycle_status: '已完成' })
    .eq('id', orderId);

  // 日志
  await (supabase.from('milestone_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'force_complete',
    note: `CEO 强制标记订单 ${order.order_no} 为已完成`,
  });

  // 评分
  try {
    const { calculateOrderScore } = await import('@/app/actions/commissions');
    await calculateOrderScore(orderId);
  } catch {}

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');

  return { data: { order_no: order.order_no } };
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
  
  // 从 milestone_logs 读取（关联 milestone 名称）
  const { data: logs, error } = await (supabase
    .from('milestone_logs') as any)
    .select('id, milestone_id, order_id, action, note, actor_user_id, created_at, milestones(name)')
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
      .select('user_id, full_name, name, email')
      .in('user_id', actorIds);
    profileMap = (profiles || []).reduce((m: any, p: any) => { m[p.user_id] = p.full_name || p.name || p.email?.split('@')[0] || '未知'; return m; }, {});
  }

  // 附加姓名+节点名到日志
  const logsWithNames = (logs || []).map((l: any) => ({
    ...l,
    actor_name: profileMap[l.actor_user_id] || null,
    milestone_name: l.milestones?.name || null,
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
