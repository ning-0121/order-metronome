import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { OSDecisionKernel } from '@/lib/os/kernel';
import { resolveEntry } from '@/lib/os/registry';
import { HubClient } from './HubClient';

// QIMO OS 统一入口（Phase A）。新增页，不改现有登录默认跳转。
export default async function HubPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name, email').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  // Kernel v1：唯一决策入口决定可见系统（UI 结构不变）
  const decision = OSDecisionKernel({ user: { id: user.id, email: (profile as any)?.email || user.email || user.id, roles } });
  const cards = decision.systemAccess.map((s) => ({
    id: s.id,
    name: s.name,
    desc: s.desc,
    icon: s.icon,
    kind: s.kind,
    href: resolveEntry(s),
  }));

  const displayName = (profile as any)?.name || (profile as any)?.email?.split('@')[0] || user.email;

  return <HubClient cards={cards} userName={displayName} roles={roles} />;
}
