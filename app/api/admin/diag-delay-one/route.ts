import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * 临时诊断:这一条延期(50354794)审批时报「Delay request not found」但 widget/面板还显示它。
 * 用 service-role 查它到底存不存在、什么状态、链是什么、里程碑还在不在。用完删。
 * GET /api/admin/diag-delay-one
 */
export async function GET() {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return NextResponse.json({ error: '仅管理员可访问' }, { status: 403 });

  const svc = createServiceRoleClient();
  const delayId = '50354794-b742-4594-8b18-839d599b2349';

  // 1) 按 id 直查这条延期(全字段)
  const { data: one, error: oneErr } = await (svc.from('delay_requests') as any)
    .select('*').eq('id', delayId).maybeSingle();

  // 2) 它的里程碑还在吗
  let milestone: any = null;
  if (one?.milestone_id) {
    const { data: ms } = await (svc.from('milestones') as any)
      .select('id, name, status, due_at, order_id').eq('id', one.milestone_id).maybeSingle();
    milestone = ms || '❌ 里程碑不存在(被删/重排导致 delay 悬空?)';
  }

  // 3) 这条延期所属订单的所有延期(看是否 id 变了/有重复)
  let siblings: any[] = [];
  if (one?.order_id) {
    const { data: sib } = await (svc.from('delay_requests') as any)
      .select('id, status, milestone_id, approval_chain, current_step, delay_days, created_at')
      .eq('order_id', one.order_id).order('created_at', { ascending: false });
    siblings = sib || [];
  }

  return NextResponse.json({
    查询的delayId: delayId,
    这条延期是否存在: one ? '✅ 存在' : '❌ 不存在(service-role 也查不到 → 已被删)',
    查询报错: oneErr?.message || null,
    这条延期原始记录: one ? {
      id: one.id, status: one.status, milestone_id: one.milestone_id,
      approval_chain: one.approval_chain, current_step: one.current_step,
      delay_days: one.delay_days, order_id: one.order_id,
      proposed_new_anchor_date: one.proposed_new_anchor_date,
      proposed_new_due_at: one.proposed_new_due_at, created_at: one.created_at,
    } : null,
    关联里程碑: milestone,
    同订单所有延期: siblings,
    诊断提示: !one ? '延期行已被删 → widget/面板是缓存,硬刷新应消失;若仍在则前端缓存问题'
      : (one.status !== 'pending' ? `延期状态是 ${one.status}(不是 pending)→ 已处理过` : '延期存在且 pending → 审批却 not found 很反常,看 approval_chain 是否为空'),
  }, { status: 200 });
}
