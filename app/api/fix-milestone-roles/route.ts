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

    return NextResponse.json({ success: true, fixed: totalFixed });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
