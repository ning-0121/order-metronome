// ============================================================
// GET /api/admin/diag-order-stage?q=<订单号或内部单号>
// admin-only 诊断:为什么某单在生产中心是这个阶段?一次看清系统里到底有没有采购/物料/里程碑数据。
// 支持一个单号匹配到多单(内部单号重复也能看清)。输出 HTML,避免浏览器 JSON 乱码。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
const DONE = (s: any) => ['done', 'completed', '已完成'].includes(String(s || '').toLowerCase());

function html(body: string) {
  return new NextResponse(`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 -apple-system,sans-serif;padding:24px;max-width:900px;margin:auto}h2{margin:24px 0 8px}table{border-collapse:collapse;margin:6px 0}td,th{border:1px solid #ddd;padding:3px 8px;text-align:left}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.g{color:#059669}.r{color:#dc2626}.m{color:#6b7280}</style>${body}`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return html('<b>未登录</b>');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) return html('<b>仅管理员可用</b>');

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return html('带上 <code>?q=订单号或内部单号</code>');

  const svc = createServiceRoleClient();
  // 精确匹配(可能多单:内部单号重复);再补一个模糊匹配列出近似
  const { data: exact } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, quantity, lifecycle_status')
    .or(`order_no.eq.${q},internal_order_no.eq.${q}`).limit(20);
  let orders = (exact || []) as any[];

  if (orders.length === 0) {
    const { data: fuzzy } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no, customer_name')
      .or(`order_no.ilike.%${q}%,internal_order_no.ilike.%${q}%`).limit(20);
    const list = (fuzzy || []) as any[];
    return html(`<h2>没有精确匹配 <code>${esc(q)}</code></h2>` +
      (list.length ? `<p>近似的单(order_no / internal_order_no 含「${esc(q)}」):</p><table><tr><th>order_no</th><th>internal_order_no</th><th>客户</th></tr>${list.map((o) => `<tr><td>${esc(o.order_no)}</td><td>${esc(o.internal_order_no)}</td><td>${esc(o.customer_name)}</td></tr>`).join('')}</table>` : '<p class="r">连近似的都没有 —— 这个号在 orders 表里根本不存在。</p>'));
  }

  let out = `<h2>匹配到 ${orders.length} 单${orders.length > 1 ? '(⚠ 内部单号/订单号重复!)' : ''}</h2>`;
  for (const order of orders) {
    const oid = order.id;
    const [pli, bom, ms, pos] = await Promise.all([
      (svc.from('procurement_line_items') as any).select('line_status').eq('order_id', oid),
      (svc.from('materials_bom') as any).select('id', { count: 'exact', head: true }).eq('order_id', oid),
      (svc.from('milestones') as any).select('step_key, status').eq('order_id', oid),
      (svc.from('purchase_orders') as any).select('po_no, status, approval_status').contains('order_ids', [oid]),
    ]);
    const lines = (pli as any).data || [];
    const dist: Record<string, number> = {};
    for (const l of lines) dist[l.line_status || 'null'] = (dist[l.line_status || 'null'] || 0) + 1;
    const msByKey: Record<string, string> = {};
    for (const m of ((ms as any).data || [])) msByKey[m.step_key] = m.status;
    const placed = msByKey['procurement_order_placed'];
    const placedDone = DONE(placed);
    const noData = lines.length === 0 && !placedDone;

    out += `<h2>${esc(order.order_no)} · 内部 ${esc(order.internal_order_no)} · ${esc(order.customer_name)} <span class="m">(${esc(order.lifecycle_status)}, ${esc(order.quantity)}件)</span></h2>`;
    out += `<table>
      <tr><td>采购执行行(procurement_line_items)</td><td>${lines.length} 条 ${lines.length ? '· ' + esc(JSON.stringify(dist)) : '<span class="r">(空 → 生产中心算未起料)</span>'}</td></tr>
      <tr><td>BOM 原辅料行</td><td>${(bom as any).count ?? 0} 条</td></tr>
      <tr><td>采购下单里程碑(procurement_order_placed)</td><td>${placed ? `<b class="${placedDone ? 'g' : 'r'}">${esc(placed)}</b>` : '<span class="m">该单无此里程碑</span>'}</td></tr>
      <tr><td>关联采购单</td><td>${((pos as any).data || []).length ? ((pos as any).data).map((p: any) => `${esc(p.po_no)}(${esc(p.status)}/${esc(p.approval_status)})`).join('、') : '<span class="m">无</span>'}</td></tr>
    </table>`;
    out += noData
      ? `<p class="r">➡ 系统里既<b>无采购执行行</b>、采购下单里程碑也<b>未完成</b> → 生产中心确实"不知道"它物料在途。这不是识别错,是采购数据没进系统。要显示物料在途:把「采购下单」里程碑标完成,或把采购补录进系统。</p>`
      : lines.length === 0 && placedDone
        ? `<p class="g">➡ 无执行行但「采购下单」里程碑已完成 → 我新加的兜底会判它为<b>物料在途</b>(部署后刷新即对)。</p>`
        : `<p class="g">➡ 有采购执行行 → 按行状态派生阶段(若仍不对,把本页发我)。</p>`;
  }
  return html(out);
}
