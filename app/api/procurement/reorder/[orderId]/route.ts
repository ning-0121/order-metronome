// GET /api/procurement/reorder/:orderId
// 内部端点：session 鉴权 + 角色门控。返回返单 payload（READ-ONLY，绝不写库）。

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getUserRoles } from '@/lib/utils/user-role';
import { resolveCapabilities } from '@/lib/procurement/visibility';
import { buildReorderPayload } from '@/lib/procurement/reorder';

export async function GET(_req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const roles = await getUserRoles(supabase, user.id);
  const caps = resolveCapabilities(roles);
  if (!caps.view) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const payload = await buildReorderPayload(supabase as unknown as SupabaseClient, orderId);
  if (!payload) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(payload, { status: 200 });
}
