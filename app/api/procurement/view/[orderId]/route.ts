// GET /api/procurement/view/:orderId
// 内部端点（QIMO 登录用户）：session 鉴权（middleware）+ 真实角色能力门控。
// READ-ONLY · DERIVED-never-stored。

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getUserRoles } from '@/lib/utils/user-role';
import { resolveCapabilities } from '@/lib/procurement/visibility';
import { buildProcurementView } from '@/lib/procurement/procurementView';

export async function GET(_req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const roles = await getUserRoles(supabase, user.id);
  const caps = resolveCapabilities(roles);
  if (!caps.view) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // session 客户端 → RLS 限制行可见性；能力裁剪字段/分组可见性。
  const view = await buildProcurementView(
    supabase as unknown as SupabaseClient,
    orderId,
    caps,
    new Date().toISOString(),
  );
  if (!view) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(view, { status: 200 });
}
