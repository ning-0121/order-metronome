import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

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
  const isAdmin = delRoles.includes('admin');
  const isCancelled = ['cancelled', '已取消'].includes(String((order as any).lifecycle_status || ''));

  // ── 库存流水硬闸(2026-07-04 审计 P0)──
  // inventory_transactions 是 append-only(触发器禁删)+ order_id RESTRICT → 有库存流水的订单正常删不掉,走取消。
  // 例外(2026-07-06 用户拍板):管理员对"已取消"单可「彻底清除测试单」→ 走 admin_purge_order RPC 连流水一起清。
  const { count: invCount } = await (supabase.from('inventory_transactions') as any)
    .select('id', { count: 'exact', head: true }).eq('order_id', id);
  const needPurge = (invCount || 0) > 0;
  if (needPurge && !(isAdmin && isCancelled)) {
    return NextResponse.json({
      error: '此单已有库存进出记录(收货入库/领料),不能物理删除(会残留库存流水账)。请改用「取消订单」——取消会保留可审计的历史并通知财务冲销。（已取消的测试单可由管理员「彻底清除」）',
    }, { status: 409 });
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
  if (needPurge) {
    // 已取消单带库存流水 → 走 SECURITY DEFINER RPC:事务内临时禁 append-only 闸删流水,再删订单(级联)
    const { error: purgeErr } = await (createServiceRoleClient() as any).rpc('admin_purge_order', { p_order_id: id });
    if (purgeErr) {
      const notFound = /function .*admin_purge_order.* does not exist|could not find/i.test(purgeErr.message || '');
      return NextResponse.json({
        error: notFound
          ? '彻底清除功能的数据库函数尚未创建,请先在 Supabase 执行 20260706_admin_purge_order.sql'
          : `彻底清除失败：${purgeErr.message}`,
      }, { status: notFound ? 409 : 500 });
    }
  } else {
    const { error } = await (supabase.from('orders') as any).delete().eq('id', id);
    if (error) {
      return NextResponse.json({ error: `删除失败：${error.message}` }, { status: 500 });
    }
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
