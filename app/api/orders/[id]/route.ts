import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

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
    .select('id, order_no, lifecycle_status, created_by')
    .eq('id', id)
    .single();

  if (!order) {
    return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  }

  const { isAdmin } = await getCurrentUserRole(supabase);

  // 权限分级：
  // - 管理员：任意状态都能删（强制清理）
  // - 非管理员：只能删自己创建的 draft 订单
  if (!isAdmin) {
    if (order.lifecycle_status && order.lifecycle_status !== 'draft') {
      return NextResponse.json(
        { error: '只有草稿状态的订单可以删除，已启动的订单请走取消流程或联系管理员' },
        { status: 400 }
      );
    }
    if (order.created_by !== user.id) {
      return NextResponse.json(
        { error: '无权删除：只有订单创建者或管理员可以删除' },
        { status: 403 }
      );
    }
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

  // 删除订单
  const { error } = await (supabase.from('orders') as any).delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: `删除失败：${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true, order_no: order.order_no, forced: isAdmin && order.lifecycle_status !== 'draft' });
}
