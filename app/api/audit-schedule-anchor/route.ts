/**
 * 排期锚点审计 — 找出所有模板日期锚错的订单
 *
 * 病征（两类）：
 *   A) po_confirmed 已完成 actual_at > due_at + 5 天（锚点过早）
 *      → 表明排期起点在 PO 真正确认日之前，所有下游 due_at 都过早
 *   B) 存在 actual_at IS NULL 且 due_at < 订单创建日 — 3 天 的里程碑
 *      → 不可能的情形：关卡的计划截止日早于订单创建日
 *
 * 使用：
 *   GET  /api/audit-schedule-anchor             → 只诊断，返回清单
 *   POST /api/audit-schedule-anchor?apply=true  → 自动修复（把锚点错的订单按 PO actual_at 重锚 offset 天）
 *
 * 需管理员鉴权（走 admin allowlist）
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

const ADMIN_EMAIL_ALLOWLIST = ['alex@qimoclothing.com', 'su@qimoclothing.com'];

interface AuditRow {
  order_id: string;
  order_no: string;
  customer_name: string | null;
  lifecycle_status: string | null;
  created_at: string;
  po_due_at: string | null;
  po_actual_at: string | null;
  offset_days: number | null;       // PO 实际与计划差多少天（正数 = 延后完成/锚点错）
  impossible_milestones: number;    // due_at 早于订单创建日的里程碑数量
  pending_past_due: number;         // 未完成且已逾期的里程碑数
  diagnosis: string;
  suggested_shift: number | null;   // 建议顺延天数（仅 A 型有）
}

async function getSupabaseClient(req: Request): Promise<{ client: any; error?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { client: null, error: 'Missing Supabase config' };

  // 简易鉴权：Authorization Bearer 或 浏览器访问时检查 cookie session 通过 user email
  const authHeader = req.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (authHeader === `Bearer ${cronSecret}` && cronSecret) {
    return { client: createClient(url, serviceKey) };
  }

  // 回退：走用户 session（服务端 client）检查 admin email
  const { createClient: createServer } = await import('@/lib/supabase/server');
  const sb = await createServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return { client: null, error: 'Unauthorized' };
  if (!ADMIN_EMAIL_ALLOWLIST.includes(user.email.toLowerCase())) {
    return { client: null, error: 'Forbidden — admin only' };
  }
  return { client: createClient(url, serviceKey) };
}

async function auditAllOrders(supabase: any): Promise<AuditRow[]> {
  // 1) 所有活着的订单（非 cancelled / completed / paused）
  const ACTIVE = ['执行中', 'running', 'active', '已生效'];
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, lifecycle_status, created_at')
    .in('lifecycle_status', ACTIVE);

  if (!orders || orders.length === 0) return [];

  const orderIds = orders.map((o: any) => o.id);

  // 2) 所有里程碑
  const { data: milestones } = await supabase
    .from('milestones')
    .select('id, order_id, step_key, due_at, actual_at')
    .in('order_id', orderIds);

  const msByOrder = new Map<string, any[]>();
  for (const m of milestones || []) {
    if (!msByOrder.has(m.order_id)) msByOrder.set(m.order_id, []);
    msByOrder.get(m.order_id)!.push(m);
  }

  const now = Date.now();
  const rows: AuditRow[] = [];

  for (const o of orders as any[]) {
    const ms = msByOrder.get(o.id) || [];
    if (ms.length === 0) continue;

    // PO 节点
    const po = ms.find((m: any) => m.step_key === 'po_confirmed');
    const po_due = po?.due_at || null;
    const po_actual = po?.actual_at || null;
    let offsetDays: number | null = null;
    if (po && po_due && po_actual) {
      offsetDays = Math.floor(
        (new Date(po_actual).getTime() - new Date(po_due).getTime()) / 86400000
      );
    }

    // 检测 B: 不可能的里程碑（due_at 早于 订单创建日 - 3 天）
    const orderCreatedTs = new Date(o.created_at).getTime();
    const impossible = ms.filter((m: any) => {
      if (!m.due_at) return false;
      return new Date(m.due_at).getTime() < orderCreatedTs - 3 * 86400000;
    }).length;

    // 未完成已逾期数
    const pendingPastDue = ms.filter((m: any) =>
      !m.actual_at && m.due_at && new Date(m.due_at).getTime() < now
    ).length;

    // 诊断
    const diagnoses: string[] = [];
    let suggestedShift: number | null = null;

    if (offsetDays !== null && offsetDays > 5) {
      diagnoses.push(`A: PO 锚点错 ${offsetDays} 天（计划 ${po_due?.slice(0, 10)}，实际 ${po_actual?.slice(0, 10)}）`);
      suggestedShift = offsetDays;
    }
    if (impossible > 0) {
      diagnoses.push(`B: ${impossible} 个关卡 due_at 早于订单创建日 — 明显不可能`);
      if (suggestedShift === null && impossible > 3) {
        // 估算：取最早 due 跟订单创建日的差
        const earliestDue = ms
          .filter((m: any) => m.due_at)
          .reduce((min: number, m: any) => Math.min(min, new Date(m.due_at).getTime()), Infinity);
        if (Number.isFinite(earliestDue)) {
          suggestedShift = Math.ceil((orderCreatedTs - earliestDue) / 86400000);
        }
      }
    }

    if (diagnoses.length === 0) continue; // 订单没毛病

    rows.push({
      order_id: o.id,
      order_no: o.order_no,
      customer_name: o.customer_name,
      lifecycle_status: o.lifecycle_status,
      created_at: o.created_at,
      po_due_at: po_due,
      po_actual_at: po_actual,
      offset_days: offsetDays,
      impossible_milestones: impossible,
      pending_past_due: pendingPastDue,
      diagnosis: diagnoses.join(' / '),
      suggested_shift: suggestedShift,
    });
  }

  // 按建议顺延天数降序（最严重在前）
  rows.sort((a, b) => (b.suggested_shift || 0) - (a.suggested_shift || 0));
  return rows;
}

async function repairOrder(
  supabase: any, orderId: string, shiftDays: number
): Promise<{ shifted: number; error?: string }> {
  const { data: ms } = await supabase
    .from('milestones')
    .select('id, due_at, planned_at, actual_at')
    .eq('order_id', orderId)
    .is('actual_at', null);

  if (!ms || ms.length === 0) return { shifted: 0 };

  const addMs = shiftDays * 86400000;
  let shifted = 0;
  for (const m of ms) {
    const updates: any = { updated_at: new Date().toISOString() };
    if (m.due_at) updates.due_at = new Date(new Date(m.due_at).getTime() + addMs).toISOString();
    if (m.planned_at) updates.planned_at = new Date(new Date(m.planned_at).getTime() + addMs).toISOString();
    const { error } = await supabase.from('milestones').update(updates).eq('id', m.id);
    if (!error) shifted++;
  }

  // 审计 log
  await supabase.from('milestone_logs').insert({
    order_id: orderId,
    action: 'audit_anchor_repair',
    note: `[排期锚点修复] 自动顺延 ${shiftDays} 天（仅未完成关卡）`,
  }).catch(() => {});

  return { shifted };
}

export async function GET(req: Request) {
  const { client: supabase, error } = await getSupabaseClient(req);
  if (error) return NextResponse.json({ error }, { status: 401 });

  const rows = await auditAllOrders(supabase);

  return NextResponse.json({
    total_active_orders: null, // 节省一次 count
    corrupted_orders: rows.length,
    rows,
    summary: {
      type_a_wrong_anchor: rows.filter(r => (r.offset_days || 0) > 5).length,
      type_b_impossible_dates: rows.filter(r => r.impossible_milestones > 0).length,
      type_a_and_b: rows.filter(r => (r.offset_days || 0) > 5 && r.impossible_milestones > 0).length,
      total_impossible_milestones: rows.reduce((s, r) => s + r.impossible_milestones, 0),
    },
    hint: 'POST ?apply=true 自动修复（按 suggested_shift 批量顺延未完成关卡）',
  });
}

export async function POST(req: Request) {
  const { client: supabase, error } = await getSupabaseClient(req);
  if (error) return NextResponse.json({ error }, { status: 401 });

  const url = new URL(req.url);
  const apply = url.searchParams.get('apply') === 'true';
  const orderNoFilter = url.searchParams.get('order_no'); // 可选：只修一张订单

  const rows = await auditAllOrders(supabase);
  const targets = orderNoFilter
    ? rows.filter(r => r.order_no === orderNoFilter)
    : rows.filter(r => r.suggested_shift !== null && r.suggested_shift > 0);

  if (!apply) {
    return NextResponse.json({
      dry_run: true,
      would_repair: targets.length,
      targets: targets.map(t => ({
        order_no: t.order_no,
        customer: t.customer_name,
        shift_days: t.suggested_shift,
        diagnosis: t.diagnosis,
      })),
      hint: '再加 &apply=true 实际执行',
    });
  }

  let totalShifted = 0;
  const results: any[] = [];
  for (const t of targets) {
    if (!t.suggested_shift) continue;
    const { shifted, error } = await repairOrder(supabase, t.order_id, t.suggested_shift);
    totalShifted += shifted;
    results.push({
      order_no: t.order_no,
      shift_days: t.suggested_shift,
      shifted_milestones: shifted,
      error,
    });
  }

  return NextResponse.json({
    success: true,
    orders_repaired: results.length,
    total_milestones_shifted: totalShifted,
    results,
  });
}
