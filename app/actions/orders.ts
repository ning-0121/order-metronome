'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
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
import { normalizeStyleFabrics, primaryFabricColumns } from '@/lib/services/style-fabrics';
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

  // 权限：业务开发(sales)、理单/订单执行(merchandiser)、业务部经理(sales_manager)、
  //       订单管理经理(order_manager)、管理员(admin) 可创建订单。
  //       绮陌政策：业务开发与理单都能建单，方便操作（2026-06-18）。
  const { data: creatorProfile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const creatorRoles: string[] = (creatorProfile as any)?.roles?.length > 0 ? (creatorProfile as any).roles : [(creatorProfile as any)?.role].filter(Boolean);
  const canCreate = creatorRoles.some(r => ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'].includes(r));
  if (!canCreate) {
    return { ok: false, error: '仅业务开发/理单、业务部或业务执行经理、管理员可以创建订单（当前账号角色：' + (creatorRoles.join('、') || '未设置') + '）' };
  }

  if (!preGeneratedOrderNo) {
    return { ok: false, error: '订单号未生成，请刷新页面重试' };
  }
  // ── STEP 2: validate — 提取并校验表单字段 ──
  const customer_id = String(formData.get('customer_id') || '').trim();
  const submittedCustomerName = String(formData.get('customer_name') || '').trim();
  if (!customer_id) return { ok: false, error: '请选择并确认客户' };

  // Customer ID is the contract. Resolve the canonical name under the caller's RLS scope;
  // never accept a visible label or a stale hidden name as business truth.
  const { data: selectedCustomerRecord, error: selectedCustomerError } = await (supabase.from('customers') as any)
    .select('id, customer_name')
    .eq('id', customer_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (selectedCustomerError || !selectedCustomerRecord?.customer_name) {
    return { ok: false, error: '所选客户不存在或当前账号无权访问，请重新选择客户' };
  }
  const customer_name = String(selectedCustomerRecord.customer_name).trim();
  if (submittedCustomerName && submittedCustomerName !== customer_name) {
    return { ok: false, error: '客户信息已更新，请重新选择客户后再创建订单' };
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

  // 国内送仓字段（仅 domestic 必填）
  const delivery_warehouse_name = formData.get('delivery_warehouse_name') as string | null;
  const delivery_address = formData.get('delivery_address') as string | null;
  const delivery_contact = formData.get('delivery_contact') as string | null;
  const delivery_phone = formData.get('delivery_phone') as string | null;
  const delivery_required_at = formData.get('delivery_required_at') as string | null;

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
  } catch (e: any) { console.warn(`[orders] 订单次要操作 164:`, e?.message); }

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
  // 统一按件数存储：套（2件）= 数量 × 2，套（3件/三件套）= 数量 × 3，件 = ×1
  const rawQty = totalQuantity ? parseInt(totalQuantity, 10) : null;
  const setMultiplier = quantityUnit === '套' ? 2 : quantityUnit === '三件套' ? 3 : 1;
  const quantity = rawQty ? rawQty * setMultiplier : rawQty;
  const styleCount = formData.get('style_count') as string | null;
  const colorCount = formData.get('color_count') as string | null;

  if (!internal_order_no?.trim()) return { ok: false, error: '请填写内部订单号（订单册编号），财务需要此编号进行核算' };
  // Stable submission idempotency: a retry after a lost/stale response reuses the order created
  // by this user and this pre-generated order number. It never creates or mutates another order.
  {
    const { data: prior } = await (supabase.from('orders') as any)
      .select('id, internal_order_no, created_by')
      .eq('order_no', preGeneratedOrderNo)
      .maybeSingle();
    if (prior && (prior as any).created_by === user.id && (prior as any).internal_order_no === internal_order_no.trim()) {
      return { ok: true, orderId: (prior as any).id };
    }
  }
  // 防内部单号撞车(2026-07-04 审计):同一内部单号只能有一张活跃订单,否则财务按内部号对账会串单。
  {
    const { data: dupIno } = await (supabase.from('orders') as any)
      .select('order_no, lifecycle_status')
      .eq('internal_order_no', internal_order_no.trim())
      .not('lifecycle_status', 'in', '("cancelled","已取消","archived","已归档")')
      .limit(1)
      .maybeSingle();
    if (dupIno) return { ok: false, error: `内部单号「${internal_order_no.trim()}」已被订单 ${(dupIno as any).order_no} 占用。请勿重复导入;如需新单请换内部单号。` };
  }
  if (!etd && incoterm === 'DDP') return { ok: false, error: 'DDP 条款请填写 ETD（离港日）' };
  if (!warehouse_due_date && incoterm === 'DDP') return { ok: false, error: 'DDP 条款请填写 ETA（到港/到仓日）' };
  if (!factory_date) return { ok: false, error: '请填写出厂日期' };
  if (!quantity) return { ok: false, error: '请填写预估总数量' };
  if (!styleCount) return { ok: false, error: '请填写款数' };

  // 国内送仓校验：创建时允许全部为空（部分客户尚未确认仓库/地址/联系人/送达日期）。
  // 推进到「包装方式确认」节点前必须补齐 → 见 app/actions/milestones.ts hard-block。
  // 14 天后仍缺失则由 missing_info 任务自动催办 → 见 generateMissingInfoTasks。
  // 颜色待定:颜色还没定就能先建单(勾了「颜色待定」免填颜色数),后期到订单明细补齐并取消标签。
  const colorPending = formData.get('color_pending') === 'true';
  if (!colorCount && !colorPending) return { ok: false, error: '请填写颜色数（颜色还没定?勾「颜色待定」即可先建单,后期补）' };

  // ── 日期合理性校验 ──
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const orderDt = order_date ? new Date(order_date) : today;
  const factoryDt = new Date(factory_date);

  // 出厂日期不能是过去的离谱日期
  if (factoryDt < new Date('2020-01-01')) {
    return { ok: false, error: `出厂日期 ${factory_date} 明显不对，请检查` };
  }

  // 下单到出厂最少7天（面料采购+生产需要时间）
  const daysToFactory = Math.ceil((factoryDt.getTime() - orderDt.getTime()) / 86400000);
  if (daysToFactory < 7) {
    return { ok: false, error: `下单日到出厂日仅 ${daysToFactory} 天，最少需要 7 天（含采购和生产时间）。如确实是加急单请选择"加急订单"类型。` };
  }

  // ── 日期链 invariant 校验（SSOT, 2026-05-18）──
  // 原本分散的 4 个日期顺序检查统一到 lib/domain/orderDates.ts，
  // 同样的校验也用于 updateOrder + approveDelayRequest，全路径一致。
  {
    const { validateOrderDateChain, formatDateChainErrors } = await import('@/lib/domain/orderDates');
    const violations = validateOrderDateChain({
      order_date,
      factory_date,
      etd,
      warehouse_due_date,
      eta: formData.get('eta') as string | null,
      cancel_date,
    });
    if (violations.length > 0) {
      return { ok: false, error: formatDateChainErrors(violations) };
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
      // 废单/已完结不算重复(2026-07-08 用户:取消/完成的旧单不该挡新建)
      .not('lifecycle_status', 'in', '("cancelled","已取消","completed","已完成","archived","已归档")')
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
    // P0(2026-07-06 审计):去审批后正常新单曾因不显式设状态而落 DB 默认 '草稿'、永不激活,
    //   导致 AI 巡检/晨报/日报三大风险面板对所有新生产单静默失效(卡风险命门)。
    //   按"内部单号=线下审批,创建即 active"口径,建单即生效。import/已发货分支会各自覆盖。
    lifecycle_status: 'active',
    quantity: quantity,
    quantity_unit: quantityUnit,
    // 客户 PO 成交价(业务上传 PO 解析所得,表单已人工复核)→ 落库并随 order.created 同步财务。
    // 财务据 total_amount/unit_price 自动建 draft 预算(total_revenue=总额),供财务审 单价/件数/总额。
    // 仅落草稿(财务侧 status=draft、created_by=null),财务审批后才入账 —— 符合 AI 产出须审批的铁律。
    // FormData 无这些字段时(如报价快照建单路径未喂价)返回 {},对既有行为零影响。
    ...(() => {
      const up = Number(formData.get('unit_price'));
      const ta = Number(formData.get('total_amount'));
      const cur = (formData.get('currency') as string) || '';
      const unitPrice = Number.isFinite(up) && up > 0 ? up : null;
      const totalAmount = Number.isFinite(ta) && ta > 0
        ? ta
        : (unitPrice != null && quantity > 0 ? Number((unitPrice * quantity).toFixed(2)) : null);
      const patch: Record<string, any> = {};
      if (unitPrice != null) patch.unit_price = unitPrice;
      if (totalAmount != null) patch.total_amount = totalAmount;
      if (cur) patch.currency = cur;
      return patch;
    })(),
    style_count: styleCount ? parseInt(styleCount, 10) : null,
    color_count: colorCount ? parseInt(colorCount, 10) : null,
    factory_date: factory_date || null,
    // P2-2 AQL 前置：合同条款的一部分，订单创建时录入
    aql_standard: (formData.get('aql_standard') as string) || null,
    eta: eta || warehouse_due_date || null,
    delivery_type,
    // 国内送仓字段（仅 domestic 时有值）
    delivery_warehouse_name: delivery_type === 'domestic' ? (delivery_warehouse_name?.trim() || null) : null,
    delivery_address:        delivery_type === 'domestic' ? (delivery_address?.trim() || null)        : null,
    delivery_contact:        delivery_type === 'domestic' ? (delivery_contact?.trim() || null)        : null,
    delivery_phone:          delivery_type === 'domestic' ? (delivery_phone?.trim() || null)          : null,
    delivery_required_at:    delivery_type === 'domestic' ? (delivery_required_at || null)            : null,
    order_purpose,
    notes: (formData.get('notes') as string) || null,
    // AI 原始识别冻结底档(有 PO 解析才有):只读原文,纠错追溯用;工作版在 order_line_items
    ...(() => {
      const raw = formData.get('po_parse_snapshot') as string | null;
      if (!raw) return {};
      try { return { po_parse_snapshot: JSON.parse(raw), po_parse_snapshot_at: new Date().toISOString() }; }
      catch { return {}; }
    })(),
    special_tags: [
      formData.get('has_plus_size') === 'true' ? '大码款' : '',
      formData.get('high_stretch') === 'true' ? '高弹面料' : '',
      formData.get('light_color_risk') === 'true' ? '浅色风险' : '',
      formData.get('color_clash_risk') === 'true' ? '撞色风险' : '',
      formData.get('complex_print') === 'true' ? '复杂印花' : '',
      formData.get('tight_deadline') === 'true' ? '交期紧急' : '',
      colorPending ? '颜色待定' : '',   // = COLOR_PENDING_TAG(lib/domain/colorPending):PO确认免颜色核对,顶部常驻提醒
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
  // sales(po_confirmed=业务开发交接点)与 merchandiser(PO 后业务执行 12 节点,2026-07-10 由 sales 翻过来)
  // 都默认归建单人 → 保证计分/催办/操作不中断;高洁(order_manager)可用「理单跟单」按需改派到具体理单员。
  const roleUserMap: Record<string, string | null> = { sales: user.id, merchandiser: user.id };
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
        } catch (e: any) { console.warn(`[orders] 订单次要操作 570:`, e?.message); }
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
    console.log('[createOrder] STAGE: STEP 6 isImport branch(直接激活,去审批), step=', importCurrentStep);
    try {
      // 6a. 直接激活(2026-07-06 用户拍板:去掉进行中导入审批 —— 内部单号=线下审批,创建即导入即 active)
      await (supabase.from('orders') as any)
        .update({
          imported_at: new Date().toISOString(),
          import_current_step: importCurrentStep,
          lifecycle_status: 'active',
          notes: importReason
            ? `[进行中导入] ${importReason}\n${orderData.notes || ''}`
            : orderData.notes || null,
        })
        .eq('id', orderData.id);

      // 6b. 里程碑激活(原 approveImportOrder 逻辑内联):已过步骤 done、当前步骤 in_progress
      try {
        const templates = (await import('@/lib/milestoneTemplate')).MILESTONE_TEMPLATE_V1;
        const currentIndex = templates.findIndex(t => t.step_key === importCurrentStep);
        if (currentIndex >= 0) {
          const { data: milestones } = await (supabase.from('milestones') as any)
            .select('id, sequence_number, due_at').eq('order_id', orderData.id).order('sequence_number', { ascending: true });
          const currentSeq = currentIndex + 1;
          for (const ms of (milestones || []) as any[]) {
            const updates: any = {};
            if (ms.sequence_number < currentSeq) { updates.status = 'done'; updates.actual_at = ms.due_at || new Date().toISOString(); }
            else if (ms.sequence_number === currentSeq) { updates.status = 'in_progress'; }
            if (Object.keys(updates).length > 0) await (supabase.from('milestones') as any).update(updates).eq('id', ms.id);
          }
        }
      } catch (e: any) { console.warn('[createOrder] 导入里程碑激活失败(不阻断):', e?.message); }

      // 6c. 财务同步(active)——创建即到财务
      try {
        const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
        await syncOrderToFinance(orderData, 'order.activated');
      } catch (e: any) { console.warn('[createOrder] 导入财务同步失败(不阻断):', e?.message); }

      revalidatePath('/orders');
      return { ok: true, orderId: orderData.id };
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
  } catch (e: any) { console.warn(`[orders] 通知失败不阻断订单创建:`, e?.message); }

  // ── 推送到财务系统 ──
  try {
    const { syncOrderToFinance, syncQuotationToFinance } = await import('@/lib/integration/finance-sync');
    await syncOrderToFinance(orderData, 'order.created');
    // 内部成本核算单已冻结(上传PO时解析入 order_cost_baseline) → emit quotation.frozen,
    // 财务用共享订单数量×单件单价自动建预算(带核算日期)。先建单后填预算,顺序正确。
    const oid = (orderData as any)?.id;
    if (oid) {
      const { data: baseline } = await (supabase.from('order_cost_baseline') as any).select('*').eq('order_id', oid).maybeSingle();
      await syncQuotationToFinance(orderData as Record<string, unknown>, baseline ?? null);
    }
  } catch (e: any) { console.warn(`[orders] 财务推送失败不阻断订单创建:`, e?.message); }

  // 经销/采购成品单(trade)的逐款价 → 财务(成本+应收)在 STEP 10 落完明细后统一算,见下方 trade 块。

  // ── STEP 7: 初始化经营数据 + 确认链 ──
  try {
    const { initOrderFinancials } = await import('@/app/actions/order-financials');
    await initOrderFinancials(orderData.id);
  } catch (e: any) { console.warn(`[orders] 初始化失败不阻断订单创建:`, e?.message); }

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
    } catch (e: any) { console.warn(`[orders] 回顾存储失败不阻断订单创建:`, e?.message); }
  }

  // ── STEP 9: 交期已过订单处理 ──
  // 2026-05-15 重要修复：原本用 try/catch {} 静默吞错，但 Supabase await
  // 不抛错只返回 {error}，导致 milestone update 失败时 lifecycle_status
  // 仍被设为 'completed' → 形成 ghost milestone（订单已完成但节点没标完，
  // 财务/生产视图持续显示逾期，业务又改不了）。
  // 现改为：每步显式检查 error，failure 时回滚或不再继续。
  const pastDateStatus = formData.get('past_date_status') as string | null;
  const pastDateReason = formData.get('past_date_reason') as string | null;
  if (pastDateStatus) {
    if (pastDateStatus === 'shipped') {
      // 已发货：先把所有节点标完成，确认成功后再标订单完成
      const now = new Date().toISOString();
      const { error: msErr, count: msUpdated } = await (supabase.from('milestones') as any)
        .update({ status: 'done', actual_at: now }, { count: 'exact' })
        .eq('order_id', orderData.id);

      if (msErr) {
        console.error('[createOrder] STEP 9 已发货：milestone 标完失败', msErr.message);
        // milestone 没标完就不要标 lifecycle=completed，否则 ghost
        // 回退到 'active'，让业务后续手动用「强制标完」补救
        await (supabase.from('orders') as any)
          .update({
            lifecycle_status: 'active',
            notes: (orderData.notes || '') + `\n\n【补录失败】已发货标记节点完成失败：${msErr.message}（请管理员手动处理）`,
          })
          .eq('id', orderData.id);
      } else {
        // milestone 标完成功，标订单 completed
        const { error: ordErr } = await (supabase.from('orders') as any)
          .update({
            lifecycle_status: 'completed',
            notes: (orderData.notes || '') + `\n\n【补录】已发货订单，系统自动标记完成（已更新 ${msUpdated ?? '?'} 个节点）`,
          })
          .eq('id', orderData.id);
        if (ordErr) {
          console.error('[createOrder] STEP 9 已发货：lifecycle 更新失败', ordErr.message);
          // 节点已全标 done 但订单状态未变 — 这种情况下 order 仍是 draft/active，
          // 不会产生 ghost（因为节点已全 done），后续可手动结案。不阻断订单创建。
        }
      }
    } else if (pastDateStatus === 'problem') {
      // 有问题：记录原因到订单备注 + 标记为 active 加交期逾期标签
      const { error: probErr } = await (supabase.from('orders') as any)
        .update({
          lifecycle_status: 'active',
          notes: (orderData.notes || '') + `\n\n【交期已过未发货】原因：${pastDateReason || '未说明'}`,
          special_tags: [...(orderData.special_tags || []), '交期逾期'],
        })
        .eq('id', orderData.id);
      if (probErr) console.error('[createOrder] STEP 9 problem 状态更新失败', probErr.message);
    } else {
      // pending（在途）：正常激活
      const { error: pendErr } = await (supabase.from('orders') as any)
        .update({ lifecycle_status: 'active' })
        .eq('id', orderData.id);
      if (pendErr) console.error('[createOrder] STEP 9 pending 状态更新失败', pendErr.message);
    }
  }

  // ── STEP 10: 落库 PO 明细行 + 碎单预警 ──
  // 建单时 AI 已解析出逐款逐色明细,这里落入 order_line_items(只存一次,日后生产单/单据/
  // 客户报告复用,避免重复调 AI 解析烧钱);同时检查碎单(每色 < 150 件)→ 站内通知业务主管 + CEO。
  // 全程 fire-and-forget,任何失败都不阻断订单创建(沿用 Runtime 钩子哲学)。
  try {
    const { assessSmallBatchFromLineItems, assessSmallBatchFromAverage } =
      await import('@/lib/services/small-batch');

    let assessment: ReturnType<typeof assessSmallBatchFromLineItems> | null = null;

    // 1) 有解析明细 → 展开成 (款×色) 行,落库 + 逐色精确判定
    const lineItemsRaw = formData.get('line_items') as string | null;
    let parsedStyles: any[] = [];
    if (lineItemsRaw) {
      try { parsedStyles = JSON.parse(lineItemsRaw); } catch { parsedStyles = []; }
    }

    // ── 多客户PO合单:先落库来源PO容器,得到 po_number → order_customer_pos.id 映射 ──
    // 客户裂分多张PO但交期一致 → 合并为一个内部订单号。前端只传 PO号字符串做归属,
    // 这里解析成 FK(source_order_po_id)。设计:docs/Designs/Multi-PO-Merge-Order-V1.0.md。
    // 单PO/老单不传 customer_pos → poMap 为空,source_order_po_id 全为 null,行为不变(向后兼容)。
    // 优雅降级:order_customer_pos 表未建时静默跳过,绝不阻断建单(沿用 po_unit_price 降级哲学)。
    const poMap = new Map<string, string>();   // customer_po_number → order_customer_pos.id
    try {
      const customerPosRaw = formData.get('customer_pos') as string | null;
      let customerPos: any[] = [];
      if (customerPosRaw) { try { customerPos = JSON.parse(customerPosRaw); } catch { customerPos = []; } }
      // 去重 + 保序:同一 PO 号只落一行
      const seenPo = new Set<string>();
      const poRows: any[] = [];
      let poSeq = 0;
      for (const p of (Array.isArray(customerPos) ? customerPos : [])) {
        const num = String(p?.po_number ?? '').trim();
        if (!num || seenPo.has(num)) continue;
        seenPo.add(num);
        poSeq++;
        const amt = p?.po_amount === '' || p?.po_amount == null ? null : Number(p.po_amount);
        poRows.push({
          order_id: orderData.id,
          customer_po_number: num,
          seq: poSeq,
          po_amount: amt != null && !isNaN(amt) ? amt : null,
          created_by: user.id,
        });
      }
      if (poRows.length > 0) {
        const { data: insertedPos, error: poErr } = await (supabase.from('order_customer_pos') as any)
          .insert(poRows).select('id, customer_po_number');
        if (poErr) {
          console.warn('[createOrder] order_customer_pos 落库失败(不阻断,来源PO溯源降级):', poErr.message);
        } else {
          for (const row of (insertedPos || [])) poMap.set(row.customer_po_number, row.id);
        }
      }
    } catch (e: any) { console.warn('[createOrder] 多PO容器处理异常(不阻断):', e?.message); }

    if (Array.isArray(parsedStyles) && parsedStyles.length > 0) {
      const rows: any[] = [];
      let lineNo = 0;
      let kitSeq = 0;                                    // 异色套装组序号
      for (const st of parsedStyles) {
        const colors = Array.isArray(st?.colors) ? st.colors : [];
        const poPrice = st?.po_unit_price === '' || st?.po_unit_price == null ? null : Number(st.po_unit_price);
        const purchaseCost = st?.purchase_unit_cost === '' || st?.purchase_unit_cost == null ? null : Number(st.purchase_unit_cost);  // 逐款采购价(trade)
        const fabrics = normalizeStyleFabrics(st);       // 多布料(优先 fabrics,缺则旧 fabric_* 合成)
        const prim = primaryFabricColumns(fabrics);      // 第一条镜像回旧列做兼容
        // 异色套装:本款各颜色=一套的组件,同 set_group_no;套价(po_unit_price)只放第一色(主组件),
        //   其余色为 null → 应收 Σ(单价×件数)=套数×套价,不重复计价。非套装款照旧每色同价。
        const setGroupNo = st?.kit_set ? `SET-${++kitSeq}` : null;
        for (const [ci, c] of colors.entries()) {
          lineNo++;
          // qty 优先取 c.qty;富录入表不维护 qty 字段 → 从 sizes 求和兜底
          const sizesSum = Object.values(c?.sizes || {}).reduce((s: number, v: any) => s + (Number(v) || 0), 0);
          const qty = Number(c?.qty ?? 0) || sizesSum;
          // 箱数(该色行)——建单富录入表填的箱数要落库,否则生产任务单/PI 拉不到(2026-07-08 用户)
          const cartons = c?.carton_count === '' || c?.carton_count == null ? null : Number(c.carton_count);
          rows.push({
            order_id: orderData.id,
            line_no: lineNo,
            style_no: st?.style_no || null,
            product_name: st?.product_name || st?.name || null,
            color_cn: c?.color_cn || null,
            color_en: c?.color_en || null,
            sizes: c?.sizes || {},
            unit: 'pcs',
            set_multiplier: 1,
            qty_pcs: qty || null,
            qty_raw: qty || null,
            carton_count: cartons != null && !isNaN(cartons) ? cartons : null,
            image_url: st?.image_url || null,
            remark: c?.remark || null,
            fabric_name: prim.fabric_name,
            fabric_width: prim.fabric_width,
            fabric_consumption: prim.fabric_consumption,
            fabric_unit: prim.fabric_unit,
            fabrics: fabrics.length > 0 ? fabrics : null,   // 多布料明细(JSONB);列缺失时降级剔除见下
            // 异色套装:套价只写主组件(第一色),其余色为 null,避免应收按色重复计价
            po_unit_price: (setGroupNo && ci > 0) ? null : (poPrice != null && !isNaN(poPrice) ? poPrice : null),
            purchase_unit_cost: purchaseCost != null && !isNaN(purchaseCost) ? purchaseCost : null,   // 逐款采购价(trade成本面)
            source_order_po_id: poMap.get(String(st?.source_po_number ?? '').trim()) || null,  // 多PO合单:本行来自哪张客户PO
            set_group_no: setGroupNo,   // 异色套装组(各色同套)
            source: 'po_parse',
          });
        }
      }
      if (rows.length > 0) {
        let { error: liErr } = await (supabase.from('order_line_items') as any).insert(rows);
        if (liErr && /po_unit_price|carton_count|fabrics|source_order_po_id|purchase_unit_cost|set_group_no|column .* does not exist/i.test(liErr.message || '')) {
          // po_unit_price/carton_count/多布料/source_order_po_id/purchase_unit_cost/set_group_no(20260711)迁移未执行 → 降级去掉这些列重插,不阻断建单
          const plain = rows.map(({ po_unit_price, carton_count, fabrics, source_order_po_id, purchase_unit_cost, set_group_no, ...rest }) => rest);
          ({ error: liErr } = await (supabase.from('order_line_items') as any).insert(plain));
        }
        if (liErr) console.warn('[createOrder] order_line_items 落库失败(不阻断):', liErr.message);
        assessment = assessSmallBatchFromLineItems(rows);
        // S1.2:每款布料 → 同步该款 BOM 第一行(失败不阻断建单)。trade(买成品)无原辅料 → 跳过,不产生 BOM
        if (order_purpose !== 'trade') {
          try {
            const { syncStyleFabricsToBom } = await import('@/lib/services/style-fabric-sync');
            await syncStyleFabricsToBom(supabase, orderData.id, user.id, parsedStyles);
          } catch (e: any) { console.warn('[createOrder] 布料同步 BOM 失败(不阻断):', e?.message); }
        }
      }
    }

    // 2) 没有明细 → 用「总件数 ÷ 颜色数」平均值回退判定(老单/手填单)
    if (!assessment) {
      const cc = colorCount ? parseInt(colorCount, 10) : 0;
      assessment = assessSmallBatchFromAverage(quantity || 0, cc);
    }

    // 3) 碎单 + 生产订单 → 站内通知业务主管(sales_manager)+ CEO(admin)
    if (assessment.triggered && order_purpose === 'production') {
      const { data: managers } = await (supabase.from('profiles') as any)
        .select('user_id')
        .or('role.eq.sales_manager,roles.cs.{sales_manager},role.eq.admin,roles.cs.{admin}');
      const recipientIds = Array.from(
        new Set(((managers || []) as any[]).map((m) => m.user_id).filter(Boolean)),
      );

      const minQty = assessment.minColorQty ?? '?';
      const detail = assessment.precise
        ? assessment.smallColors.slice(0, 5)
            .map((c) => `${c.style_no ? c.style_no + ' ' : ''}${c.color}:${c.qty_pcs}件`)
            .join('、')
        : `平均每色约 ${minQty} 件`;
      const title = `⚠️ 碎单预警 — ${orderData.order_no}`;
      const message =
        `客户：${customer_name} · 共 ${quantity || '?'} 件 / ${assessment.totalColors || colorCount || '?'} 色\n` +
        `最小颜色仅 ${minQty} 件(预警线 ${assessment.threshold} 件/色）${assessment.precise ? '' : '【按平均值估算】'}\n` +
        `碎单明细：${detail}\n` +
        `碎单工艺/排产成本高,若按大货价报价恐亏损,请评估报价或与客户协商起订量。`;

      for (const uid of recipientIds) {
        await (supabase.from('notifications') as any).insert({
          user_id: uid,
          type: 'small_batch_warning',
          title,
          message,
          related_order_id: orderData.id,
          status: 'unread',
        });
      }
    }
  } catch (sbErr: any) {
    console.warn('[createOrder] 碎单预警/明细落库失败(不阻断订单创建):', sbErr?.message);
  }

  // ── 经销/采购成品单(trade)逐款价 → 财务(成本+应收)──
  // 明细已落库(STEP 10),这里按 order_line_items 逐款价 × 数量 汇总,自洽:
  //   应收 = Σ(po_unit_price × qty) → 更新 orders.total_amount + 重发 order.updated;
  //   采购成本 = Σ(purchase_unit_cost × qty) → order.budget_updated(放 cmt 桶让 total=采购成本)。
  // 逐款不同价天然支持;全程 fire-and-forget,不阻断建单。
  if (order_purpose === 'trade') {
    try {
      const { data: lines } = await (supabase.from('order_line_items') as any)
        .select('qty_pcs, po_unit_price, purchase_unit_cost').eq('order_id', orderData.id);
      let revenueTotal = 0, purchaseTotal = 0;
      for (const l of (lines || [])) {
        const q = Number(l.qty_pcs) || 0;
        revenueTotal += (Number(l.po_unit_price) || 0) * q;
        purchaseTotal += (Number(l.purchase_unit_cost) || 0) * q;
      }
      revenueTotal = Math.round(revenueTotal * 100) / 100;
      purchaseTotal = Math.round(purchaseTotal * 100) / 100;

      // 应收:total_amount 从逐款汇总(表单无整单价);unit_price 存加权均价供展示
      if (revenueTotal > 0) {
        const avgUnit = quantity && quantity > 0 ? Math.round((revenueTotal / quantity) * 100) / 100 : null;
        const patch: any = { total_amount: revenueTotal };
        if (avgUnit != null) patch.unit_price = avgUnit;
        try { await (supabase.from('orders') as any).update(patch).eq('id', orderData.id); }
        catch (e: any) { console.warn('[orders trade] 应收落库失败(不阻断):', e?.message); }
        try {
          const { data: fresh } = await (supabase.from('orders') as any).select('*').eq('id', orderData.id).maybeSingle();
          if (fresh) {
            const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
            await syncOrderToFinance(fresh as Record<string, unknown>, 'order.updated');
          }
        } catch (e: any) { console.warn('[orders trade] 应收推财务失败(不阻断):', e?.message); }
      }
      // 采购成本 → 财务预算单成本面
      if (purchaseTotal > 0) {
        try {
          const { syncOrderBudgetToFinance } = await import('@/lib/integration/finance-sync');
          await syncOrderBudgetToFinance({
            qimo_order_id: orderData.id,
            order_no: (orderData as any).order_no ?? null,
            internal_order_no: (orderData as any).internal_order_no ?? null,
            quantity,
            cmt_amount: purchaseTotal,          // 成品采购成本 → 总额桶(finance 以 budget_totals.total 为权威)
            actual_cmt_amount: purchaseTotal,   // 采购即实付,预算=实际
          });
        } catch (e: any) { console.warn('[orders trade] 采购成本推财务失败(不阻断):', e?.message); }
      }
    } catch (e: any) { console.warn('[orders trade] 逐款价汇总失败(不阻断):', e?.message); }
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

/** 兜底防止订单表无限增长拖垮列表页 — 历史订单超过这个数会被截断。
 *  超过后再做分页 / 归档/ filter 下推。当前规模 ~1000 单远低于此。 */
const ORDERS_HARD_LIMIT = 2000;

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

  // 管理/生产主管/各经理/业务开发(只读全程) 看全部订单
  const canSeeAll = isAdmin || roles.some((r: string) => ['finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'].includes(r)); // 2026-07:业务员(sales)移出,只看自己的单

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
      .select('id, order_no, customer_name, factory_name, factory_id, incoterm, etd, warehouse_due_date, lifecycle_status, order_type, packaging_type, notes, created_at, style_no, po_number, internal_order_no, quantity, quantity_unit, cancel_date, order_date, factory_date, special_tags, owner_user_id, created_by, milestones(id, name, step_key, status, due_at, planned_at, actual_at, owner_role, owner_user_id, sequence_number)')
      .order('created_at', { ascending: false })
      .limit(ORDERS_HARD_LIMIT);
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

  // 普通员工(含业务员):只看自己创建的 + 自己负责的 + 被分配了关卡的订单
  const { data: ownedOrders } = await (supabase.from('orders') as any)
    .select('id').eq('owner_user_id', user.id);
  const { data: createdOrders } = await (supabase.from('orders') as any)
    .select('id').eq('created_by', user.id); // 2026-07:补 created_by,业务员看得到自己建的单
  const { data: assignedMilestones } = await (supabase.from('milestones') as any)
    .select('order_id').eq('owner_user_id', user.id);

  const myOrderIds = [...new Set([
    ...(ownedOrders || []).map((o: any) => o.id),
    ...(createdOrders || []).map((o: any) => o.id),
    ...(assignedMilestones || []).map((m: any) => m.order_id),
  ])];

  if (myOrderIds.length === 0) return { data: [] };

  const { data: orders, error } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_name, factory_id, incoterm, etd, warehouse_due_date, lifecycle_status, order_type, packaging_type, notes, created_at, style_no, po_number, internal_order_no, quantity, quantity_unit, cancel_date, order_date, factory_date, special_tags, milestones(id, name, step_key, status, due_at, planned_at, actual_at, owner_role, owner_user_id, sequence_number)')
    .in('id', myOrderIds)
    .order('created_at', { ascending: false })
    .limit(ORDERS_HARD_LIMIT);

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
  if (!order) return { data: null };

  // 订单级访问控制(P0 审计:此前任意登录用户可凭 URL 拉任意订单 → 触达采购底价)。
  // 放行:看全部订单的角色 / 创建者 / 跟单负责人 / 被指派了该单里程碑的人。
  try {
    const { getUserRoles } = await import('@/lib/utils/user-role');
    const { hasRoleInGroup } = await import('@/lib/domain/roles');
    const roles = await getUserRoles(supabase, user.id);
    const canSeeAll = roles.includes('admin') || hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS');
    const isOwner = (order as any).created_by === user.id || (order as any).owner_user_id === user.id;
    let assigned = false;
    if (!canSeeAll && !isOwner) {
      const { data: ms } = await (supabase.from('milestones') as any)
        .select('id').eq('order_id', id).eq('owner_user_id', user.id).limit(1);
      assigned = (ms || []).length > 0;
    }
    if (!canSeeAll && !isOwner && !assigned) {
      return { error: '无权查看此订单(仅创建者/负责人/被指派人/管理层可见)' };
    }
  } catch (e: any) {
    // 修 P3(2026-07-09 审计):鉴权判定异常应 fail-safe 拒绝(与 canUserAccessOrder 一致),
    // 不再 fail-open 放行——否则一旦 SELECT RLS 放宽,这里就是唯一越权口子。
    console.warn('[getOrder] 访问控制判定异常,安全拒绝:', e?.message);
    return { error: '订单访问校验异常,请刷新重试' };
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
    } else {
      // FOB: 只用 factory_date 作为锚点
      updates.etd = etd;
      updates.warehouse_due_date = null;
    }

    // ── 日期链 invariant 校验（SSOT, 2026-05-18）──
    // 读取订单现有日期作为基线，merge 进 updates 后整体校验
    const { data: existingOrder } = await (supabase.from('orders') as any)
      .select('order_date, factory_date, etd, warehouse_due_date, eta, cancel_date')
      .eq('id', id)
      .single();
    if (existingOrder) {
      const { validateDateChainWithUpdate, formatDateChainErrors } = await import('@/lib/domain/orderDates');
      const violations = validateDateChainWithUpdate(existingOrder, {
        etd: updates.etd,
        warehouse_due_date: updates.warehouse_due_date,
        factory_date: factory_date || existingOrder.factory_date,
      });
      if (violations.length > 0) {
        return { error: formatDateChainErrors(violations) };
      }
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
    // 防撞车(2026-07-04 审计):改成的内部单号不能已被别的活跃订单占用
    if (value?.trim()) {
      const { data: dupIno } = await (supabase.from('orders') as any)
        .select('order_no')
        .eq('internal_order_no', value.trim())
        .neq('id', orderId)
        .not('lifecycle_status', 'in', '("cancelled","已取消","archived","已归档")')
        .limit(1).maybeSingle();
      if (dupIno) return { ok: false, error: `内部单号「${value.trim()}」已被订单 ${(dupIno as any).order_no} 占用,不能重复。` };
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
  } catch (e: any) { console.warn(`[orders] 订单次要操作 1063:`, e?.message); }

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

  // 权限检查(2026-07-04 用户拍板:业务申请取消 → 财务审批;admin 也可)
  const { data: _cprof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const _croles: string[] = (_cprof as any)?.roles?.length ? (_cprof as any).roles : [(_cprof as any)?.role].filter(Boolean);
  if (!_croles.some((r) => ['admin', 'finance'].includes(r))) {
    return { error: '无权审批:仅财务/管理员可审批取消申请' };
  }

  const result = await decideCancel(cancelRequestId, decision, decisionNote);
  
  if (result.error) {
    return { error: result.error };
  }
  
  // 批准 → 下游清理(财务冲销 + PO 作废 + 执行行 cancelled + 清风险 + 通知采购/生产)。
  // 复审:抽成 finalizeCancelledOrder 与财务回调(H3)共用同一套;用 service-role 保证 PO/runtime 写不受 RLS 影响。
  if (decision === 'approved') {
    const oid = (result.data as any)?.cancelRequest?.order_id;
    if (oid) {
      try {
        const { createServiceRoleClient } = await import('@/lib/supabase/server');
        const { finalizeCancelledOrder } = await import('@/lib/repositories/ordersRepo');
        await finalizeCancelledOrder(createServiceRoleClient(), oid);
      } catch (e: any) { console.warn('[decideCancelAction] 取消清理失败(不阻断):', e?.message); }
    }
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
  } catch (e: any) { console.warn(`[orders] 订单次要操作 1217:`, e?.message); }

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

  // 批准进行中导入订单：管理员(CEO) 或 财务（2026-06-18：原仅财务，admin 看不到审批入口）
  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const canApprove = userRoles.includes('finance') || userRoles.includes('admin');
  if (!canApprove) return { error: '仅财务或管理员可审批进行中订单' };

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

  // 激活订单（必须先成功，否则不推进任何节点，避免「节点已推进但订单仍待审批」的错乱）
  const { error: activateErr } = await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'active' })
    .eq('id', orderId);
  if (activateErr) {
    return { error: `激活订单失败，审批已中止：${activateErr.message}` };
  }

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
          // 优先走 RPC；失败则兜底直接 update —— 两条路径都 await 并检查 error，禁止悬空 Promise
          let rpcOk = false;
          try {
            const { error: rpcErr } = await (supabase.rpc as any)('admin_update_milestone', {
              _milestone_id: ms.id,
              _updates: updates,
            });
            rpcOk = !rpcErr;
          } catch { rpcOk = false; }
          if (!rpcOk) {
            const { error: fbErr } = await (supabase.from('milestones') as any)
              .update(updates)
              .eq('id', ms.id);
            if (fbErr) {
              console.error('[approveImportedOrder] 里程碑推进失败:', ms.id, fbErr.message);
            }
          }
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

  // 拒绝进行中导入订单：管理员或财务（与批准对齐，避免财务看得到按钮却批不了/拒不了）
  const { data: rejecterProfile } = await supabase
    .from('profiles').select('role, roles').eq('user_id', user.id).single();
  const rejecterRoles: string[] = (rejecterProfile as any)?.roles?.length > 0
    ? (rejecterProfile as any).roles
    : [(rejecterProfile as any)?.role].filter(Boolean);
  if (!rejecterRoles.includes('admin') && !rejecterRoles.includes('finance')) {
    return { error: '仅管理员或财务可拒绝' };
  }

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
  // ⚠️ 2026-04-27 统一为英文（清账：lifecycle_status 中英混用）
  const { error: completeError } = await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'completed' })
    .eq('id', orderId);
  // 状态写失败必须中止——否则节点已全部 done、后续还会算佣金，但订单仍未完成，状态错乱
  if (completeError) {
    return { error: `标记订单完成失败：${completeError.message}` };
  }

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
  } catch (e: any) { console.warn(`[orders] 订单次要操作 1394:`, e?.message); }

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

const PURPOSE_CHANGEABLE = ['production', 'trade', 'consign'];

async function getActorRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
}

/**
 * 订单用途变更的核心重算(service-role 执行,记真实 actor)。仅供已鉴权的入口调用:
 *  - changeOrderPurpose(财务/管理员直接改)
 *  - decideOrderPurposeChange(审批通过后执行,actor = 审批人)
 *
 * 温和 diff(不走 rebuildOrderMilestones 的删光重建,保留已完成进度与日志):
 *   删:新模板不含、且「未完成」的里程碑(已完成的保留作历史);加:新模板有、当前缺的(pending)。
 * 例:production → consign 只删掉未完成的「采购下单」节点。
 */
async function applyOrderPurposeChange(
  orderId: string, newPurpose: string, reason: string | undefined, actorUserId: string | null,
): Promise<{ ok?: boolean; error?: string; added?: number; removed?: number; from?: string }> {
  if (!PURPOSE_CHANGEABLE.includes(newPurpose)) return { error: '不支持的订单用途(仅 自产/经销/委托加工 之间可改)' };
  const svc = createServiceRoleClient();

  const { data: order, error: oErr } = await (svc.from('orders') as any)
    .select('id, order_no, order_purpose, order_type, incoterm, delivery_type, order_date, created_at, etd, warehouse_due_date, eta, sample_phase, sample_confirm_days_override, factory_date')
    .eq('id', orderId).maybeSingle();
  if (oErr) return { error: `读取订单失败:${oErr.message}` };
  if (!order) return { error: '订单不存在' };
  const o = order as any;
  const oldPurpose = o.order_purpose || 'production';
  if (oldPurpose === newPurpose) return { ok: true, added: 0, removed: 0, from: oldPurpose };
  if (!PURPOSE_CHANGEABLE.includes(oldPurpose)) return { error: `当前用途「${oldPurpose}」不在可改范围(样品/询价单请走建单流程)` };

  const incoterm: string = o.incoterm || 'FOB';
  const deliveryType: string = o.delivery_type || (['RMB_EX_TAX', 'RMB_INC_TAX'].includes(incoterm) ? 'domestic' : 'export');

  const { getApplicableMilestones } = await import('@/lib/milestoneTemplate');
  const { calcDueDates } = await import('@/lib/schedule');
  const templates = getApplicableMilestones(o.order_type, deliveryType === 'export', deliveryType, newPurpose, false, o.sample_phase || undefined);
  const newStepKeys = new Set(templates.map((t: any) => t.step_key));

  const { data: existing } = await (svc.from('milestones') as any)
    .select('id, step_key, status, sequence_number').eq('order_id', orderId);
  const cur = (existing || []) as any[];
  const curStepKeys = new Set(cur.map(m => m.step_key));
  const isDone = (s: string) => ['done', '已完成'].includes(String(s || '').toLowerCase());

  const now = new Date().toISOString();
  const { error: upErr } = await (svc.from('orders') as any)
    .update({ order_purpose: newPurpose, updated_at: now }).eq('id', orderId);
  if (upErr) return { error: `更新用途失败:${upErr.message}` };

  const toRemove = cur.filter(m => !newStepKeys.has(m.step_key) && !isDone(m.status));
  let removed = 0;
  if (toRemove.length > 0) {
    const { error: delErr } = await (svc.from('milestones') as any).delete().in('id', toRemove.map(m => m.id));
    if (delErr) return { error: `清理旧节点失败:${delErr.message}(用途已改,请重试或联系管理员)` };
    removed = toRemove.length;
  }

  const toAdd = templates.filter((t: any) => !curStepKeys.has(t.step_key));
  let added = 0;
  if (toAdd.length > 0) {
    let dueDates: Record<string, any> = {};
    try {
      dueDates = calcDueDates({
        orderDate: o.order_date, createdAt: o.created_at ? new Date(o.created_at) : undefined,
        incoterm: (incoterm === 'DDP' ? 'DDP' : 'FOB') as 'FOB' | 'DDP',
        etd: o.etd, warehouseDueDate: o.warehouse_due_date, eta: o.eta,
        orderType: (o.order_type as 'sample' | 'bulk' | 'repeat') || 'bulk',
        shippingSampleRequired: deliveryType === 'export',
        sampleConfirmDaysOverride: o.sample_confirm_days_override,
        skipPreProductionSample: false,
      }) as any;
    } catch { dueDates = {}; }
    const fallbackDue = o.factory_date ? new Date(o.factory_date + 'T00:00:00+08:00').toISOString() : (o.eta ? new Date(o.eta).toISOString() : now);
    const maxSeq = cur.reduce((mx, m) => Math.max(mx, Number(m.sequence_number) || 0), 0);
    const rows = toAdd.map((t: any, i: number) => {
      const raw = dueDates[t.step_key];
      const dueIso = raw ? (raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString()) : fallbackDue;
      return {
        order_id: orderId, step_key: t.step_key, name: t.name, owner_role: t.owner_role, owner_user_id: null,
        planned_at: dueIso, due_at: dueIso, status: 'pending',
        is_critical: !!t.is_critical, evidence_required: !!t.evidence_required, evidence_note: t.evidence_note || null,
        blocks: t.blocks || [], sequence_number: maxSeq + i + 1,
      };
    });
    const { error: insErr } = await (svc.from('milestones') as any).insert(rows);
    if (insErr) return { error: `新增节点失败:${insErr.message}(用途已改,可用「重建里程碑」补齐)` };
    added = rows.length;
  }

  const anchorMs = cur.find(m => !toRemove.some(r => r.id === m.id)) || cur[0];
  if (anchorMs) {
    await (svc.from('milestone_logs') as any).insert({
      milestone_id: anchorMs.id, order_id: orderId, action: 'order_purpose_changed', actor_user_id: actorUserId,
      note: `订单用途 ${oldPurpose} → ${newPurpose}(删 ${removed} 加 ${added} 节点)${reason ? `:${reason}` : ''}`,
      payload: { from: oldPurpose, to: newPurpose, removed, added, by: actorUserId },
    }).then(() => {}, () => {});
  }

  try {
    const { fireRuntimeRecompute } = await import('@/lib/repositories/milestonesRepo');
    fireRuntimeRecompute(orderId, { type: 'order_purpose_changed', from: oldPurpose, to: newPurpose });
  } catch { /* 风险重算触发失败不阻断 */ }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/procurement');
  return { ok: true, added, removed, from: oldPurpose };
}

/**
 * 财务/管理员「直接改」订单用途 —— 他们本身是审批人,无需自己给自己提请。
 * 铁律合规:人在 UI 操作,记真实 auth.uid()。
 */
export async function changeOrderPurpose(
  orderId: string, newPurpose: string, reason?: string,
): Promise<{ ok?: boolean; error?: string; added?: number; removed?: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getActorRoles(supabase, user.id);
  if (!roles.includes('admin') && !roles.includes('finance')) {
    return { error: '仅财务或管理员可直接修改;业务执行请用「申请改用途」提交审批' };
  }
  return applyOrderPurposeChange(orderId, newPurpose, reason, user.id);
}

/**
 * 业务执行「申请改用途」—— 提交待审批申请(不落库变更),由财务/管理员审批后才真正改。
 * 合铁律:提请只记诉求,真正的写(改用途+重算里程碑)在审批通过时以审批人身份执行。
 */
export async function requestOrderPurposeChange(
  orderId: string, toPurpose: string, reason?: string,
): Promise<{ ok?: boolean; error?: string }> {
  if (!PURPOSE_CHANGEABLE.includes(toPurpose)) return { error: '不支持的目标用途' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getActorRoles(supabase, user.id);
  const canPropose = roles.some(r => ['sales', 'sales_manager', 'merchandiser', 'order_manager', 'admin', 'finance'].includes(r));
  if (!canPropose) return { error: '无权申请修改订单用途' };

  const svc = createServiceRoleClient();
  const { data: order } = await (svc.from('orders') as any).select('id, order_purpose').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const from = (order as any).order_purpose || 'production';
  if (from === toPurpose) return { error: '目标用途与当前一致,无需申请' };

  const { data: dup } = await (svc.from('order_purpose_change_requests') as any)
    .select('id').eq('order_id', orderId).eq('status', 'pending').limit(1);
  if (dup && dup.length > 0) return { error: '该订单已有待审批的改用途申请,请等财务/管理员处理' };

  const { error } = await (svc.from('order_purpose_change_requests') as any).insert({
    order_id: orderId, from_purpose: from, to_purpose: toPurpose, reason: reason || null,
    status: 'pending', requested_by: user.id,
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * 财务/管理员审批「改用途申请」。通过 → 以审批人身份执行变更;驳回 → 记原因。
 */
export async function decideOrderPurposeChange(
  requestId: string, approve: boolean, note?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getActorRoles(supabase, user.id);
  if (!roles.includes('admin') && !roles.includes('finance')) return { error: '仅财务或管理员可审批改用途申请' };

  const svc = createServiceRoleClient();
  const { data: req } = await (svc.from('order_purpose_change_requests') as any).select('*').eq('id', requestId).maybeSingle();
  if (!req) return { error: '申请不存在' };
  const r = req as any;
  if (r.status !== 'pending') return { error: '该申请已处理' };

  const now = new Date().toISOString();
  if (!approve) {
    const { error } = await (svc.from('order_purpose_change_requests') as any)
      .update({ status: 'rejected', decided_by: user.id, decided_at: now, decision_note: note || null, updated_at: now })
      .eq('id', requestId).eq('status', 'pending');
    if (error) return { error: error.message };
    revalidatePath(`/orders/${r.order_id}`);
    return { ok: true };
  }

  const applied = await applyOrderPurposeChange(r.order_id, r.to_purpose, r.reason || note, user.id);
  if (applied.error) return { error: `执行变更失败:${applied.error}` };
  const { error } = await (svc.from('order_purpose_change_requests') as any)
    .update({ status: 'approved', decided_by: user.id, decided_at: now, decision_note: note || null, updated_at: now })
    .eq('id', requestId).eq('status', 'pending');
  if (error) return { error: error.message };
  revalidatePath(`/orders/${r.order_id}`);
  revalidatePath('/procurement');
  return { ok: true };
}

/**
 * 跨系统入口:财务系统审批通过后,由 finance-callback 调用执行改用途。
 * actor 记 null(财务审批人非节拍器 auth 用户),审批人名已由调用方并入 reason/留痕。
 */
export async function applyOrderPurposeChangeFromCallback(
  orderId: string, toPurpose: string, reason?: string,
): Promise<{ ok?: boolean; error?: string; added?: number; removed?: number }> {
  return applyOrderPurposeChange(orderId, toPurpose, reason, null);
}

/** 读该订单待审批的改用途申请(带申请人名),供订单页横幅渲染。 */
export async function getPurposeChangeRequests(orderId: string): Promise<{ data: any[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };
  const svc = createServiceRoleClient();
  const { data } = await (svc.from('order_purpose_change_requests') as any)
    .select('id, order_id, from_purpose, to_purpose, reason, status, requested_by, created_at')
    .eq('order_id', orderId).eq('status', 'pending').order('created_at', { ascending: false });
  const reqs = (data || []) as any[];
  if (reqs.length === 0) return { data: [] };
  const ids = [...new Set(reqs.map(r => r.requested_by))];
  const { data: profs } = await (svc.from('profiles') as any).select('user_id, full_name, name, email').in('user_id', ids);
  const nameById = new Map((profs || []).map((p: any) => [p.user_id, p.full_name || p.name || p.email || '业务']));
  return { data: reqs.map(r => ({ ...r, requester_name: nameById.get(r.requested_by) || '业务' })) };
}
