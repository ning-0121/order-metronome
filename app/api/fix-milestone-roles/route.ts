/**
 * 一次性 API：批量修复里程碑责任人
 * 访问：GET /api/fix-milestone-roles（需登录）
 *
 * 修复：
 * - processing_fee_confirmed: → production_manager
 * - bulk_materials_confirmed: → production_manager
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const fixes = [
      { step_key: 'processing_fee_confirmed', new_role: 'production_manager' },
      { step_key: 'bulk_materials_confirmed', new_role: 'production_manager' },
    ];

    let totalFixed = 0;

    for (const fix of fixes) {
      const { count } = await (supabase.from('milestones') as any)
        .update({ owner_role: fix.new_role })
        .eq('step_key', fix.step_key)
        .neq('owner_role', fix.new_role)
        .select('id', { count: 'exact', head: true });

      // Supabase update doesn't return count easily, do it differently
      const { data: targets } = await (supabase.from('milestones') as any)
        .select('id')
        .eq('step_key', fix.step_key)
        .neq('owner_role', fix.new_role);

      if (targets && targets.length > 0) {
        const ids = targets.map((t: any) => t.id);
        await (supabase.from('milestones') as any)
          .update({ owner_role: fix.new_role })
          .in('id', ids);
        totalFixed += ids.length;
      }
    }

    // ── 补分配：财务/采购/生产主管节点没有 owner_user_id 的补上 ──
    let assignedCount = 0;
    try {
      const { DEFAULT_ASSIGNEES, findAssigneeUserId } = await import('@/lib/domain/default-assignees');
      const { data: allProfiles } = await (supabase.from('profiles') as any)
        .select('user_id, name, email, role, roles');
      if (allProfiles) {
        for (const [roleName, matcher] of Object.entries(DEFAULT_ASSIGNEES)) {
          const userId = findAssigneeUserId(allProfiles as any, matcher);
          if (!userId) continue;
          // 找到该角色未分配的节点
          const { data: unassigned } = await (supabase.from('milestones') as any)
            .select('id')
            .eq('owner_role', roleName)
            .is('owner_user_id', null);
          if (unassigned && unassigned.length > 0) {
            await (supabase.from('milestones') as any)
              .update({ owner_user_id: userId })
              .in('id', unassigned.map((m: any) => m.id));
            assignedCount += unassigned.length;
          }
        }
      }
    } catch {}

    // 同时修复：草稿订单批量激活
    let activatedDrafts = 0;
    const { data: drafts } = await (supabase.from('orders') as any)
      .select('id')
      .in('lifecycle_status', ['draft', '草稿', 'pending_approval']);
    if (drafts && drafts.length > 0) {
      const ids = drafts.map((d: any) => d.id);
      await (supabase.from('orders') as any)
        .update({ lifecycle_status: 'active', updated_at: new Date().toISOString() })
        .in('id', ids);
      activatedDrafts = ids.length;
    }

    return NextResponse.json({ success: true, fixed_roles: totalFixed, assigned_owners: assignedCount, activated_drafts: activatedDrafts });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
