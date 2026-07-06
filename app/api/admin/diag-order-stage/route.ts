// ============================================================
// GET /api/admin/diag-order-stage?q=<订单号或内部单号>
// admin-only 诊断:为什么某单在生产中心是这个阶段?一次看清系统里到底有没有采购/物料/里程碑数据。
// 用完即弃(排查 "物料在途被识别成待采购" 类问题)。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ error: '带上 ?q=订单号或内部单号' }, { status: 400 });

  const svc = createServiceRoleClient();
  const { data: order } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, quantity, lifecycle_status')
    .or(`order_no.eq.${q},internal_order_no.eq.${q}`).maybeSingle();
  if (!order) return NextResponse.json({ error: `没找到订单 ${q}(order_no / internal_order_no 都没匹配)` }, { status: 404 });

  const oid = (order as any).id;
  const [pli, bom, ms, pos] = await Promise.all([
    (svc.from('procurement_line_items') as any).select('line_status, material_name, purchase_order_id').eq('order_id', oid),
    (svc.from('materials_bom') as any).select('id', { count: 'exact', head: true }).eq('order_id', oid),
    (svc.from('milestones') as any).select('step_key, status').eq('order_id', oid),
    (svc.from('purchase_orders') as any).select('po_no, status, approval_status').contains('order_ids', [oid]),
  ]);

  const lineStatuses: Record<string, number> = {};
  for (const l of ((pli as any).data || [])) lineStatuses[l.line_status || 'null'] = (lineStatuses[l.line_status || 'null'] || 0) + 1;
  const msByKey: Record<string, string> = {};
  for (const m of ((ms as any).data || [])) msByKey[m.step_key] = m.status;

  return NextResponse.json({
    order: { order_no: (order as any).order_no, internal_order_no: (order as any).internal_order_no, customer: (order as any).customer_name, qty: (order as any).quantity, lifecycle: (order as any).lifecycle_status },
    生产中心口径: {
      采购执行行数_total: ((pli as any).data || []).length,
      按line_status分布: lineStatuses,
      结论: ((pli as any).data || []).length === 0 ? '⚠ 无采购执行行 → 生产中心算 total=0 → 未起料(除非采购下单里程碑已完成才兜底为物料在途)' : '有采购执行行,按状态派生阶段',
    },
    BOM原辅料行数: (bom as any).count ?? 0,
    采购下单里程碑: msByKey['procurement_order_placed'] ?? '(该单没有此里程碑)',
    关键里程碑: {
      采购下单: msByKey['procurement_order_placed'] ?? '—',
      产前样确认: msByKey['pre_production_sample_approved'] ?? '—',
      生产启动: msByKey['production_kickoff'] ?? '—',
      发货出运: msByKey['shipment_execute'] ?? '—',
    },
    关联采购单: ((pos as any).data || []).map((p: any) => ({ po_no: p.po_no, status: p.status, approval: p.approval_status })),
    诊断建议: ((pli as any).data || []).length === 0 && !['done', 'completed', '已完成'].includes(String(msByKey['procurement_order_placed'] || '').toLowerCase())
      ? '该单系统里既无采购执行行、采购下单里程碑也没完成 → 系统确实"不知道"它物料在途。要么补录采购(走提交采购/核料下单),要么把采购下单里程碑标完成,生产中心才会显示物料在途。'
      : '系统有采购/里程碑信号,应能正确派生(若仍不对请把本 JSON 发我)。',
  });
}
