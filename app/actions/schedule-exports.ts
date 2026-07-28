'use server';

/**
 * 日程导出(2026-07-27 CEO)——两张跟单计划表:
 *  1) exportOrderSchedule(orderId):单订单全节点 × 计划日期 × 负责人 × 状态,可打印发工厂。
 *  2) exportWeeklySchedule(weekStartISO?, ownerUserId?):某周内到期的所有节点,按天+跟单人排,给跟单当周作战图。
 * 只读,不改任何业务表。复用 exceljs {base64,fileName} 下载基建。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import {
  STAGE_OF_STEP, roleLabel, statusLabel, isDoneStatus,
  beijingWeekRange, bjDayParts,
} from '@/lib/exports/schedule-shared';

type ExportResult = { base64?: string; fileName?: string; error?: string };

async function requireQimoUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' as const };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  return { user, roles, name: (prof as any)?.name as string | undefined };
}

const bjDate = (iso?: string | null) => (iso ? bjDayParts(iso).ymd : '');

/** owner_user_id → 姓名 映射(批量查 profiles)。 */
async function ownerNameMap(svc: ReturnType<typeof createServiceRoleClient>, ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const m = new Map<string, string>();
  if (uniq.length === 0) return m;
  const { data } = await (svc.from('profiles') as any).select('user_id, name, email').in('user_id', uniq);
  for (const p of ((data || []) as any[])) m.set(p.user_id, p.name || p.email?.split('@')[0] || '');
  return m;
}

// ───────────────────────── 1) 单订单日程 ─────────────────────────

export async function exportOrderSchedule(orderId: string): Promise<ExportResult> {
  const auth = await requireQimoUser();
  if ('error' in auth) return { error: auth.error };
  if (!orderId) return { error: '缺少订单' };

  const svc = createServiceRoleClient();
  const { data: order, error: oErr } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, factory_date, etd, quantity, quantity_unit, order_purpose')
    .eq('id', orderId).maybeSingle();
  if (oErr) return { error: `读订单失败:${oErr.message}` };
  if (!order) return { error: '订单不存在' };

  const { data: ms, error: mErr } = await (svc.from('milestones') as any)
    .select('step_key, name, owner_role, owner_user_id, planned_at, due_at, status, is_critical, actual_at, completed_at, sequence_number')
    .eq('order_id', orderId)
    .order('sequence_number', { ascending: true });
  if (mErr) return { error: `读节点失败:${mErr.message}` };
  const rows = (ms || []) as any[];
  if (rows.length === 0) return { error: '该订单还没有节点' };

  const names = await ownerNameMap(svc, rows.map((r) => r.owner_user_id));
  const today = new Date();

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('订单日程');

  // 表头信息块
  const orderNo = order.internal_order_no || order.order_no || order.id;
  ws.addRow([`订单日程表 · ${orderNo}`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([`客户:${order.customer_name || '—'}`, '', `工厂:${order.factory_name || '—'}`, '',
    `工厂期:${bjDate(order.factory_date) || '—'}`, '', `数量:${order.quantity ?? '—'} ${order.quantity_unit || ''}`]);
  ws.addRow([]);

  const headerRowIdx = 4;
  const headers = ['序号', '阶段', '节点', '负责部门', '负责人', '计划完成日', '状态', '逾期(天)', '实际完成日', '关键'];
  ws.addRow(headers);
  ws.getRow(headerRowIdx).font = { bold: true };
  ws.getRow(headerRowIdx).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  const widths = [6, 12, 26, 16, 12, 13, 10, 9, 13, 7];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  rows.forEach((r, i) => {
    const done = isDoneStatus(r.status);
    const due = r.due_at ? new Date(r.due_at) : null;
    const overdue = !done && due && due.getTime() < today.getTime()
      ? Math.round((today.getTime() - due.getTime()) / 86400000) : '';
    const actual = r.actual_at || r.completed_at;
    const row = ws.addRow([
      i + 1,
      STAGE_OF_STEP[r.step_key] || '—',
      r.name || r.step_key,
      roleLabel(r.owner_role),
      names.get(r.owner_user_id) || (r.owner_user_id ? '(已派)' : '未派'),
      bjDate(r.due_at) || '—',
      statusLabel(r.status),
      overdue,
      bjDate(actual) || '',
      r.is_critical ? '★' : '',
    ]);
    // 逾期未完成标红,已完成标绿
    if (overdue !== '') row.getCell(8).font = { color: { argb: 'FFCC0000' }, bold: true };
    if (done) row.getCell(7).font = { color: { argb: 'FF148A3C' } };
  });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  return { base64, fileName: `订单日程_${orderNo}_${bjDate(today.toISOString())}.xlsx` };
}

// ───────────────────────── 2) 周日程(跨订单) ─────────────────────────

export async function exportWeeklySchedule(weekStartISO?: string, ownerUserId?: string): Promise<ExportResult> {
  const auth = await requireQimoUser();
  if ('error' in auth) return { error: auth.error };
  const { user, roles } = auth;
  const canSeeAll = roles.some((r) => ['admin', 'production_manager', 'order_manager', 'procurement_manager', 'admin_assistant'].includes(r));

  const svc = createServiceRoleClient();
  const anchor = weekStartISO ? new Date(weekStartISO) : new Date();
  const { start, end, label } = beijingWeekRange(anchor);

  // 非管理者只看自己负责的节点;管理者可全量或按 ownerUserId 过滤
  const effectiveOwner = canSeeAll ? (ownerUserId || null) : user.id;

  let q = (svc.from('milestones') as any)
    .select('step_key, name, owner_role, owner_user_id, due_at, status, is_critical, order_id')
    .gte('due_at', start.toISOString())
    .lt('due_at', end.toISOString())
    .not('status', 'in', '("done","completed","已完成","cancelled","已取消")')
    .order('due_at', { ascending: true });
  if (effectiveOwner) q = q.eq('owner_user_id', effectiveOwner);
  const { data: ms, error: mErr } = await q;
  if (mErr) return { error: `读节点失败:${mErr.message}` };
  const rows = (ms || []) as any[];
  if (rows.length === 0) return { error: `本周(${label})没有到期节点` };

  // 关联订单信息
  const orderIds = Array.from(new Set(rows.map((r) => r.order_id)));
  const orderMap = new Map<string, any>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: os } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no, customer_name, factory_name, order_purpose')
      .in('id', orderIds.slice(i, i + 300));
    for (const o of ((os || []) as any[])) orderMap.set(o.id, o);
  }
  const names = await ownerNameMap(svc, rows.map((r) => r.owner_user_id));
  const today = new Date();

  // 排序:先按天,再按跟单人,再按订单
  rows.sort((a, b) => {
    const da = String(a.due_at).localeCompare(String(b.due_at));
    if (da !== 0) return da;
    const na = (names.get(a.owner_user_id) || '').localeCompare(names.get(b.owner_user_id) || '');
    if (na !== 0) return na;
    return String(orderMap.get(a.order_id)?.internal_order_no || '').localeCompare(String(orderMap.get(b.order_id)?.internal_order_no || ''));
  });

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('周日程');

  ws.addRow([`周日程表 · ${label}${effectiveOwner ? '(单人)' : '(全部跟单)'}`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([`共 ${rows.length} 个到期节点 · 生成于 ${bjDate(today.toISOString())}`]);
  ws.addRow([]);

  const headerRowIdx = 4;
  const headers = ['日期', '星期', '订单', '客户', '节点', '阶段', '负责部门', '负责人', '工厂', '状态', '逾期'];
  ws.addRow(headers);
  ws.getRow(headerRowIdx).font = { bold: true };
  ws.getRow(headerRowIdx).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  const widths = [10, 7, 16, 18, 24, 12, 16, 12, 14, 9, 8];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  let prevDay = '';
  for (const r of rows) {
    const day = bjDayParts(r.due_at);
    const o = orderMap.get(r.order_id) || {};
    const due = new Date(r.due_at);
    const overdue = due.getTime() < today.getTime() ? Math.round((today.getTime() - due.getTime()) / 86400000) : '';
    // 换天加一条浅色分隔感:每天第一行给日期加粗
    const isNewDay = day.ymd !== prevDay;
    prevDay = day.ymd;
    const row = ws.addRow([
      day.dateStr, day.weekday,
      o.internal_order_no || o.order_no || '—',
      o.customer_name || '—',
      r.name || r.step_key,
      STAGE_OF_STEP[r.step_key] || '—',
      roleLabel(r.owner_role),
      names.get(r.owner_user_id) || (r.owner_user_id ? '(已派)' : '未派'),
      o.factory_name || '—',
      statusLabel(r.status),
      overdue,
    ]);
    if (isNewDay) { row.getCell(1).font = { bold: true }; row.getCell(2).font = { bold: true }; }
    if (overdue !== '') row.getCell(11).font = { color: { argb: 'FFCC0000' }, bold: true };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  return { base64, fileName: `周日程_${label.replace('/', '-').replace('~', '_')}_${rows.length}节点.xlsx` };
}
