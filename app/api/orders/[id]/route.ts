import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * DELETE /api/orders/[id]
 *
 * 删除规则：
 * - 普通业务员：只能删除 draft 状态、且自己创建的订单
 * - 管理员：可以删除任意状态的订单（强制清理用，前端会做二次确认）
 *
 * 删除会级联清理：milestones / milestone_logs / delay_requests /
 * order_attachments / notifications / order_amendments
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  // 查询订单
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, lifecycle_status, created_by')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  }

  // ── 防"半删残废订单"硬闸(2026-07-04 审计 P0)──
  // inventory_transactions.order_id 是 RESTRICT + append-only 触发器:有库存流水的订单
  // 物理删会在删完 milestones 后卡在这条 FK 报错 → 残废订单。此类单禁止物理删,走取消。
  const { count: invCount } = await (supabase.from('inventory_transactions') as any)
    .select('id', { count: 'exact', head: true }).eq('order_id', id);
  if ((invCount || 0) > 0) {
    return NextResponse.json({
      error: '此单已有库存进出记录(收货入库/领料),不能物理删除(会残留库存流水账)。请改用「取消订单」——取消会保留可审计的历史并通知财务冲销。',
    }, { status: 409 });
  }

  // 权限(2026-07-04 用户拍板):删除订单仅 admin/财务(业务连自己草稿也不能删;
  // 业务要移除订单请走「申请取消」→ 财务审批)。
  const { data: delProf } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const delRoles: string[] = (delProf as any)?.roles?.length ? (delProf as any).roles : [(delProf as any)?.role].filter(Boolean);
  if (!delRoles.some((r) => ['admin', 'finance'].includes(r))) {
    return NextResponse.json(
      { error: '无权删除订单:仅管理员/财务可删除。业务如需移除订单,请用「申请取消」提交财务审批。' },
      { status: 403 }
    );
  }

  // ── 级联清理 ──
  // milestone_logs（先删，依赖 milestones）
  const { data: milestoneRows } = await (supabase.from('milestones') as any)
    .select('id')
    .eq('order_id', id);
  const milestoneIds = (milestoneRows || []).map((m: any) => m.id);
  if (milestoneIds.length > 0) {
    await (supabase.from('milestone_logs') as any).delete().in('milestone_id', milestoneIds);
  }
  await (supabase.from('milestones') as any).delete().eq('order_id', id);
  await (supabase.from('delay_requests') as any).delete().eq('order_id', id);
  await (supabase.from('order_attachments') as any).delete().eq('order_id', id);
  // notifications 表字段名是 related_order_id
  await (supabase.from('notifications') as any).delete().eq('related_order_id', id);
  // order_amendments 也要清
  await (supabase.from('order_amendments') as any).delete().eq('order_id', id);

  // ── 采购单孤儿清理(2026-07-04 审计 P0):purchase_orders 靠 order_ids 数组关联,不 CASCADE ──
  // 从相关 PO 的 order_ids 移除本单;数组空了 → 作废该 PO(整单就为它一个订单)。
  const poNos: string[] = [];
  try {
    const { data: pos } = await (supabase.from('purchase_orders') as any)
      .select('id, po_no, order_ids').contains('order_ids', [id]);
    for (const po of (pos || [])) {
      poNos.push((po as any).po_no);
      const remain = ((po as any).order_ids || []).filter((x: string) => x !== id);
      if (remain.length === 0) {
        await (supabase.from('purchase_orders') as any).update({ status: 'cancelled', order_ids: [], updated_at: new Date().toISOString() }).eq('id', (po as any).id);
      } else {
        await (supabase.from('purchase_orders') as any).update({ order_ids: remain, updated_at: new Date().toISOString() }).eq('id', (po as any).id);
      }
    }
  } catch (e: any) { console.warn('[deleteOrder] 采购单孤儿清理失败(不阻断删除):', e?.message); }

  // 删除订单(procurement_items/line_items/requirements/goods_receipts/reservation 走 CASCADE)
  const { error } = await (supabase.from('orders') as any).delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: `删除失败：${error.message}` }, { status: 500 });
  }

  // ── 财务作废(2026-07-04 审计 P0):独立财务仓库不 CASCADE,必须 webhook 冲销应收/应付/预算 ──
  try {
    const { notifyOrderDeleted } = await import('@/lib/integration/finance-sync');
    await notifyOrderDeleted({
      id, order_no: order.order_no, internal_order_no: order.internal_order_no,
      customer_name: order.customer_name, po_nos: poNos,
    });
  } catch (e: any) { console.warn('[deleteOrder] 财务作废通知失败(未配置即跳过):', e?.message); }

  return NextResponse.json({ success: true, order_no: order.order_no, forced: order.lifecycle_status !== 'draft' });
}
