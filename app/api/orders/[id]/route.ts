import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * DELETE /api/orders/[id]
 * 删除草稿订单（仅 draft 状态可删，仅创建者或管理员）
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

  // 只有 draft 状态可以删除
  if (order.lifecycle_status && order.lifecycle_status !== 'draft') {
    return NextResponse.json({ error: '只有草稿状态的订单可以删除，已启动的订单请走取消流程' }, { status: 400 });
  }

  // 权限：创建者或管理员
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (order.created_by !== user.id && !isAdmin) {
    return NextResponse.json({ error: '无权删除：只有订单创建者或管理员可以删除' }, { status: 403 });
  }

  // 删除关联数据（级联）
  await (supabase.from('milestone_logs') as any).delete().in(
    'milestone_id',
    (await (supabase.from('milestones') as any).select('id').eq('order_id', id)).data?.map((m: any) => m.id) || []
  );
  await (supabase.from('milestones') as any).delete().eq('order_id', id);
  await (supabase.from('delay_requests') as any).delete().eq('order_id', id);
  await (supabase.from('order_attachments') as any).delete().eq('order_id', id);
  await (supabase.from('notifications') as any).delete().eq('order_id', id);

  // 删除订单
  const { error } = await (supabase.from('orders') as any).delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: `删除失败：${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true, order_no: order.order_no });
}
