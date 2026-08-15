'use server';

/**
 * 采购台账(procurement_tracking)—— 最简的「谁、什么料、几号到」逐行记录。
 *
 * ⚠️ 采购域有三张表,别搞混(2026-08-01 全面审计后正名):
 *   procurement_items       核料/归集层(71 列:算需求、找供应商、报价、财务审批)→ procurement-items.ts
 *   procurement_line_items  采购执行层(47 列:实际下单、到货、催货)          → procurement.ts / supply-chain.ts
 *   procurement_tracking    采购台账  (21 列:本文件)
 *
 * 本文件原来的函数叫 getProcurementItems / addProcurementItem / updateProcurementItem /
 * deleteProcurementItem —— 名字指向 procurement_items,实际操作的却是 procurement_tracking;
 * 而 procurement.ts 里有一组**同名**函数,操作的是 procurement_line_items。
 * 同名不同表,是这三张表在认知上糊成一团的直接原因。已按实际操作对象改名为 *TrackingRow*。
 *
 * 使用现状(2026-08-01 生产数据):台账 349 行 / 覆盖 87 张单 / 今天仍在写;
 * 而更完整的核料→执行流水线只试点了 5-6 张单就停了。也就是说**这张最简的表才是当前主力**。
 * 采购流程要往哪个方向收,是业务决策,不在本文件解决。
 */

/**
 * 采购进度共享表 — 实时协作 + 补充采购申请流
 *
 * 所有角色可查看，采购/业务/跟单/管理员可编辑
 * 每个订单一张采购跟踪表，包含面料/辅料/包装等所有采购项
 *
 * ══ 2026-04-20 补充采购申请流 ══
 * 采购单下达后如需新增物料：
 *   采购填写"补充申请"（物料+原因）→ 通知业务确认 → 业务一键确认 → 财务可审计
 * 字段：is_supplement / supplement_reason / approved_by_name / approved_at
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { insertNotifications } from '@/lib/utils/notifications';
// LEGACY / READ-ONLY / NO NEW WRITES —— Pilot 单对本表停写(非 Pilot 行为完全不变)
import { blockLegacyTrackingWrite, isPilotOrderId } from '@/lib/procurement/advanceCommand';

export interface ProcurementItem {
  id: string;
  order_id: string;
  category: string;
  item_name: string;
  supplier: string | null;
  quantity: string | null;
  order_date: string | null;
  expected_arrival: string | null;
  actual_arrival: string | null;
  status: string;
  notes: string | null;
  amount: number | null;        // 线下采购金额(RMB,2026-07-21)
  offline_paid: boolean;        // 已线下付款(计入实付回流)
  updated_by_name: string | null;
  updated_at: string;
  created_at: string;
  // 补充采购字段
  is_supplement: boolean;
  supplement_reason: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
}

/** 获取订单的采购跟踪列表 */
export async function getProcurementTrackingRows(orderId: string): Promise<{
  data?: ProcurementItem[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // R1-E server-side 投影(体检 P2-9):采购金额是红线,归 CAN_SEE_PROCUREMENT_FLOOR 管。
  // 原来 select('*') 把 amount/offline_paid 发给任何登录角色(生产/QC/物流打开采购
  // 跟踪 tab 即见每笔线下采购花了多少钱)——UI 不显示不算保护,必须在 server 层剥。
  const { hasRoleInGroup } = await import('@/lib/domain/roles');
  const { getUserRoles } = await import('@/lib/utils/user-role');
  const roles = await getUserRoles(supabase, user.id);
  const canSeeAmounts = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const SAFE_COLS = 'id, order_id, category, item_name, supplier, quantity, order_date, expected_arrival, actual_arrival, status, notes, updated_by, updated_by_name, created_at, updated_at, is_supplement, supplement_reason, approved_by_name, approved_at';
  const COLS = canSeeAmounts ? SAFE_COLS + ', amount, offline_paid' : SAFE_COLS;

  const { data, error } = await (supabase.from('procurement_tracking') as any)
    .select(COLS)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });

  if (error) return { error: error.message };
  return { data: data || [] };
}

/** 添加普通采购项（原始采购单已下达前使用）*/
export async function addProcurementTrackingRow(
  orderId: string,
  item: {
    category: string;
    item_name: string;
    supplier?: string;
    quantity?: string;
    order_date?: string;
    expected_arrival?: string;
    notes?: string;
    amount?: number | string | null;   // 线下采购金额(RMB,2026-07-21)
    offline_paid?: boolean;             // 已线下付款(计入实付回流)
  }
): Promise<{ error?: string; id?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/理单/采购/管理可维护采购项'); if (err) return { error: err }; }
  { const blocked = await blockLegacyTrackingWrite(orderId); if (blocked) return { error: blocked }; }

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  const amt = item.amount === '' || item.amount == null ? null : Number(item.amount);
  const row: any = {
    order_id: orderId,
    category: item.category || 'other',
    item_name: item.item_name,
    supplier: item.supplier || null,
    quantity: item.quantity || null,
    order_date: item.order_date || null,
    expected_arrival: item.expected_arrival || null,
    status: 'pending',
    notes: item.notes || null,
    amount: amt,
    offline_paid: !!item.offline_paid,
    updated_by: user.id,
    updated_by_name: userName,
    is_supplement: false,
  };
  // amount/offline_paid(20260721 迁移)未执行 → 去掉这两列重试,不阻断录入。
  let { data, error } = await (supabase.from('procurement_tracking') as any).insert(row).select('id').single();
  if (error && /amount|offline_paid|does not exist|schema cache/i.test(error.message || '')) {
    const { amount, offline_paid, ...rest } = row;
    ({ data, error } = await (supabase.from('procurement_tracking') as any).insert(rest).select('id').single());
  }

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { id: (data as any)?.id };
}

/**
 * 提交补充采购申请
 * - 采购单下达后新增的物料必须走此流程
 * - 创建条目后发送通知给业务/跟单，等待确认
 * - 确认前显示"待业务确认"黄色标记，财务可审计完整记录
 */
export async function submitSupplementRequest(
  orderId: string,
  item: {
    category: string;
    item_name: string;
    quantity?: string;
    supplier?: string;
    notes?: string;
    supplement_reason: string;  // 必填：补充原因
  }
): Promise<{ error?: string; id?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/理单/采购/管理可提交补充采购申请'); if (err) return { error: err }; }

  if (!item.supplement_reason?.trim()) return { error: '请填写补充原因' };
  { const blocked = await blockLegacyTrackingWrite(orderId); if (blocked) return { error: blocked }; }

  const { data: profile } = await supabase.from('profiles').select('name, role, roles').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  // 插入补充采购条目（approved_at 为 null = 待确认）
  const { data, error } = await (supabase.from('procurement_tracking') as any)
    .insert({
      order_id: orderId,
      category: item.category || 'other',
      item_name: item.item_name,
      quantity: item.quantity || null,
      supplier: item.supplier || null,
      notes: item.notes || null,
      status: 'pending',
      updated_by: user.id,
      updated_by_name: userName,
      is_supplement: true,
      supplement_reason: item.supplement_reason.trim(),
      approved_at: null,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  // 发送通知：通知订单负责人（业务/跟单）确认
  try {
    // 找订单的 owner 和业务/跟单角色用户
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, customer_name, owner_user_id')
      .eq('id', orderId)
      .single();

    const orderNo = (order as any)?.order_no || orderId;
    const customerName = (order as any)?.customer_name || '';
    const ownerId = (order as any)?.owner_user_id;

    // 通知对象：订单负责人 + 所有业务角色
    const notifyUserIds = new Set<string>();
    if (ownerId) notifyUserIds.add(ownerId);

    const { data: salesUsers } = await (supabase.from('profiles') as any)
      .select('user_id, role, roles')
      .or('role.eq.sales,role.eq.merchandiser');
    for (const u of salesUsers || []) {
      const roles: string[] = u.roles?.length > 0 ? u.roles : [u.role].filter(Boolean);
      if (roles.includes('sales') || roles.includes('merchandiser')) {
        notifyUserIds.add(u.user_id);
      }
    }

    // 不通知申请人自己
    notifyUserIds.delete(user.id);

    for (const userId of notifyUserIds) {
      await insertNotifications({
        user_id: userId,
        type: 'procurement_supplement',
        title: `📦 补充采购申请待确认 — ${orderNo}`,
        message: `${userName} 申请补充采购「${item.item_name}」${item.quantity ? `×${item.quantity}` : ''}。\n原因：${item.supplement_reason}\n订单：${orderNo}（${customerName}）\n请在订单"采购进度"Tab 确认。`,
        related_order_id: orderId,
        status: 'unread',
      });
    }
  } catch {
    // 通知失败不阻断主流程
  }

  revalidatePath(`/orders/${orderId}`);
  return { id: (data as any)?.id };
}

/**
 * 确认补充采购申请（业务/跟单/管理员操作）
 * 记录确认人和确认时间，供财务审计
 */
export async function approveSupplementRequest(itemId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 权限：业务/跟单/管理员可确认
  const { data: profile } = await supabase.from('profiles')
    .select('name, role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canApprove = roles.some(r => ['sales', 'merchandiser', 'admin', 'finance'].includes(r));
  if (!canApprove) return { error: '只有业务/跟单/管理员/财务可以确认补充采购' };

  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  const { data: item } = await (supabase.from('procurement_tracking') as any)
    .select('order_id, item_name, is_supplement, approved_at')
    .eq('id', itemId).single();

  { const blocked = item ? await blockLegacyTrackingWrite((item as any).order_id) : null; if (blocked) return { error: blocked }; }
  if (!(item as any)?.is_supplement) return { error: '该项目不是补充申请' };
  if ((item as any)?.approved_at) return { error: '该申请已经确认过了' };

  const { error } = await (supabase.from('procurement_tracking') as any)
    .update({
      approved_by_name: userName,
      approved_at: new Date().toISOString(),
      updated_by: user.id,
      updated_by_name: userName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { error: error.message };

  // 通知采购：申请已确认
  try {
    const orderId = (item as any).order_id;
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no').eq('id', orderId).single();
    const orderNo = (order as any)?.order_no || orderId;

    // 通知采购角色
    const { data: procUsers } = await (supabase.from('profiles') as any)
      .select('user_id, role, roles').or('role.eq.procurement');
    for (const u of procUsers || []) {
      await insertNotifications({
        user_id: u.user_id,
        type: 'procurement_supplement_approved',
        title: `✅ 补充采购已确认 — ${orderNo}`,
        message: `「${(item as any).item_name}」的补充采购申请已由 ${userName} 确认，可以进行采购。`,
        related_order_id: orderId,
        status: 'unread',
      });
    }

    revalidatePath(`/orders/${orderId}`);
  } catch (e: any) { console.warn(`[procurement-tracking] 采购跟踪次要操作:`, e?.message); }

  return {};
}

/** 更新采购项（任何可编辑字段）*/
export async function updateProcurementTrackingRow(
  itemId: string,
  updates: {
    item_name?: string;
    supplier?: string;
    quantity?: string;
    order_date?: string | null;
    expected_arrival?: string | null;
    actual_arrival?: string | null;
    status?: string;
    notes?: string;
    amount?: number | string | null;   // 线下采购金额(RMB,2026-07-21)
    offline_paid?: boolean;             // 已线下付款(计入实付回流)
  }
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/理单/采购/管理可维护采购项'); if (err) return { error: err }; }

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  // 归属订单前置读取(原本在 update 之后只用于 revalidate;提前是为了在写之前跑 Pilot 停写闸,
  // 没有新增查询 —— 数据访问棘轮不许业务层加 .from())
  const { data: item } = await (supabase.from('procurement_tracking') as any)
    .select('order_id').eq('id', itemId).single();
  { const blocked = item ? await blockLegacyTrackingWrite((item as any).order_id) : null; if (blocked) return { error: blocked }; }

  const patch: any = { ...updates, updated_by: user.id, updated_by_name: userName, updated_at: new Date().toISOString() };
  if ('amount' in patch) patch.amount = patch.amount === '' || patch.amount == null ? null : Number(patch.amount);
  let { error } = await (supabase.from('procurement_tracking') as any).update(patch).eq('id', itemId);
  // amount/offline_paid(20260721 迁移)未执行 → 去掉这两列重试,不阻断更新。
  if (error && /amount|offline_paid|does not exist|schema cache/i.test(error.message || '')) {
    const { amount, offline_paid, ...rest } = patch;
    ({ error } = await (supabase.from('procurement_tracking') as any).update(rest).eq('id', itemId));
  }

  if (error) return { error: error.message };

  if (item) revalidatePath(`/orders/${(item as any).order_id}`);
  return {};
}

/** 删除采购项 */
export async function deleteProcurementTrackingRow(itemId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/理单/采购/管理可删除采购项'); if (err) return { error: err }; }

  const { data: item } = await (supabase.from('procurement_tracking') as any)
    .select('order_id').eq('id', itemId).single();
  { const blocked = item ? await blockLegacyTrackingWrite((item as any).order_id) : null; if (blocked) return { error: blocked }; }

  const { error } = await (supabase.from('procurement_tracking') as any)
    .delete().eq('id', itemId);

  if (error) return { error: error.message };
  if (item) revalidatePath(`/orders/${(item as any).order_id}`);
  return {};
}

/** 快速初始化：为订单创建默认采购项（面料+辅料+包装）*/
export async function initDefaultProcurementTrackingRows(orderId: string): Promise<{ error?: string }> {
  // Pilot 单:静默跳过而不是报错 —— 本函数挂在里程碑「采购单下达」完成钩子上,
  // 抛错会把节点完成一起带崩(那才是改变了非采购链路的行为)。
  if (await isPilotOrderId(orderId)) return {};

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/理单/采购/管理可维护采购项'); if (err) return { error: err }; }

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const userName = (profile as any)?.name || '';

  const { data: existing } = await (supabase.from('procurement_tracking') as any)
    .select('id').eq('order_id', orderId).limit(1);
  if (existing && existing.length > 0) return {};

  const defaults = [
    { category: 'fabric',    item_name: '大货面料',   status: 'pending' },
    { category: 'trims',     item_name: '拉链/纽扣',  status: 'pending' },
    { category: 'trims',     item_name: '吊牌/洗标',  status: 'pending' },
    { category: 'packaging', item_name: '包装袋/纸箱', status: 'pending' },
  ];

  for (const d of defaults) {
    await (supabase.from('procurement_tracking') as any).insert({
      order_id: orderId, ...d,
      updated_by: user.id, updated_by_name: userName, is_supplement: false,
    });
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}
