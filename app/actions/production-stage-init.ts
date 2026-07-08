'use server';

/**
 * 生产主管一次性进度初始化(2026-07-08)。
 * 生产主管登录后,把每个在产订单手动归到正确的生产阶段档(修正自动推算算错的老单)。
 * 手动档做「下限」(见 lib/production/stage.ts effectiveStage)。
 * 归完由管理员点「关闭入口」;关闭后本入口只读,写操作一律拒绝。
 * 权限:仅 生产主管(production_manager)/ 管理员。写走 service-role,读走用户会话。
 */

import { revalidatePath } from 'next/cache';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';
import {
  type ProductionStage,
  MANUAL_STAGE_VALUES,
  RECEIVED, IN_TRANSIT, NOT_SECURED,
  computeStage, effectiveStage,
} from '@/lib/production/stage';

const SETTING_KEY = 'production_stage_init';

export interface StageInitRow {
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;
  customer_name: string | null;
  factory_name: string | null;
  quantity: number | null;
  factory_date: string | null;
  auto_stage: ProductionStage | 'done';                 // 系统自动推算(参考)
  manual_stage: ProductionStage | 'done' | null;         // 主管已手动设的档
  effective_stage: ProductionStage | 'done';             // 生效档(下限规则后)
}

async function resolveRoles(): Promise<{ userId: string; roles: string[] } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  return { userId: user.id, roles };
}

/** 入口是否仍开启(默认按开启处理,只有显式 open=false 才算关闭)。 */
export async function isStageInitOpen(): Promise<boolean> {
  const svc = createServiceRoleClient();
  const { data } = await (svc.from('app_settings') as any).select('value').eq('key', SETTING_KEY).maybeSingle();
  if (!data) return true;
  return (data.value as any)?.open !== false;
}

/**
 * 读取一次性初始化入口数据:开关状态 + 全部在产订单(带自动档/手动档/生效档)。
 * 仅生产主管/管理员可用。
 */
export async function getProductionStageInit(): Promise<{
  open?: boolean; rows?: StageInitRow[]; isAdmin?: boolean; error?: string;
}> {
  const r = await resolveRoles();
  if ('error' in r) return { error: r.error };
  const admin = isAdminRole(r.roles);
  if (!admin && !r.roles.includes('production_manager')) return { error: '仅生产主管或管理员可使用进度初始化入口' };

  const open = await isStageInitOpen();
  const svc = createServiceRoleClient();

  // 与生产中心同口径:建单即在产,仅排除 已取消/已完成/归档。
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, production_stage_manual')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
  const list = (orders || []) as any[];
  if (list.length === 0) return { open, rows: [], isAdmin: admin };
  const orderIds = list.map((o) => o.id);

  const [{ data: lines }, { data: ms }] = await Promise.all([
    (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', orderIds),
    (svc.from('milestones') as any).select('order_id, step_key, status')
      .in('order_id', orderIds)
      .in('step_key', ['production_kickoff', 'factory_completion', 'final_qc_check', 'shipment_execute', 'procurement_order_placed']),
  ]);

  const matByOrder = new Map<string, { total: number; received: number; in_transit: number; pending: number }>();
  for (const l of (lines || []) as any[]) {
    const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    m.total++;
    const st = String(l.line_status || '');
    if (RECEIVED.has(st)) m.received++; else if (NOT_SECURED.has(st)) m.pending++; else if (IN_TRANSIT.has(st)) m.in_transit++;
    matByOrder.set(l.order_id, m);
  }
  const msByOrder = new Map<string, Record<string, { status: string | null }>>();
  for (const m of (ms || []) as any[]) {
    const o = msByOrder.get(m.order_id) || {};
    o[m.step_key] = { status: m.status ?? null };
    msByOrder.set(m.order_id, o);
  }

  const rows: StageInitRow[] = list.map((o) => {
    const m = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    const mo = msByOrder.get(o.id) || {};
    const kickoff = mo['production_kickoff'] ? { status: mo['production_kickoff'].status, due: null } : null;
    const factoryDone = mo['final_qc_check'] || mo['factory_completion'] || null;
    const shipped = mo['shipment_execute'] || null;
    const auto = computeStage(m, kickoff, factoryDone, shipped, mo['procurement_order_placed'] || null);
    const manual = (o.production_stage_manual as ProductionStage | 'done' | null) || null;
    return {
      order_id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no,
      customer_name: o.customer_name, factory_name: o.factory_name, quantity: o.quantity,
      factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : null,
      auto_stage: auto, manual_stage: manual, effective_stage: effectiveStage(auto, manual),
    };
  });

  // 未设手动档的排前面(待处理优先),再按工厂期
  rows.sort((a, b) => {
    if (!!a.manual_stage !== !!b.manual_stage) return a.manual_stage ? 1 : -1;
    return (a.factory_date || '9999').localeCompare(b.factory_date || '9999');
  });

  return { open, rows, isAdmin: admin };
}

/** 生产主管为单个订单设手动档(可传 null 清除)。入口关闭后拒绝。 */
export async function setOrderProductionStage(
  orderId: string,
  stage: ProductionStage | 'done' | null,
): Promise<{ ok?: true; error?: string }> {
  const r = await resolveRoles();
  if ('error' in r) return { error: r.error };
  if (!isAdminRole(r.roles) && !r.roles.includes('production_manager')) return { error: '仅生产主管或管理员可设置' };
  if (stage !== null && !MANUAL_STAGE_VALUES.includes(stage)) return { error: '无效的阶段值' };
  if (!(await isStageInitOpen())) return { error: '进度初始化入口已关闭,不能再修改' };

  const svc = createServiceRoleClient();
  const { error } = await (svc.from('orders') as any)
    .update({
      production_stage_manual: stage,
      production_stage_manual_by: stage === null ? null : r.userId,
      production_stage_manual_at: stage === null ? null : new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) return { error: `保存失败:${error.message}` };
  revalidatePath('/production/stage-init');
  revalidatePath('/production');
  return { ok: true };
}

/** 关闭一次性初始化入口(仅管理员)。关闭后不可再改手动档。 */
export async function closeProductionStageInit(): Promise<{ ok?: true; error?: string }> {
  const r = await resolveRoles();
  if ('error' in r) return { error: r.error };
  if (!isAdminRole(r.roles)) return { error: '仅管理员可关闭入口' };

  const svc = createServiceRoleClient();
  const { error } = await (svc.from('app_settings') as any)
    .upsert({ key: SETTING_KEY, value: { open: false }, updated_by: r.userId, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { error: `关闭失败:${error.message}` };
  revalidatePath('/production/stage-init');
  revalidatePath('/production');
  return { ok: true };
}
