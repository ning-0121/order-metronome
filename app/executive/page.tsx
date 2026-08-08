import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ExecutiveConsole } from '@/components/exec/ExecutiveConsole';

/**
 * Executive OS V1 Thin Slice 1 页面。flag EXEC_OS_V1 关闭时 404(坏了一键关)。
 */
export const dynamic = 'force-dynamic';

export default async function ExecutivePage() {
  if (process.env.EXEC_OS_V1 !== 'on') redirect('/');   // flag 未开 → 不暴露
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  const isCeo = roles.includes('admin');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-bold text-gray-900 mb-1">🎯 Executive OS · 委托闭环</h1>
      <p className="text-xs text-gray-400 mb-6">CEO 一句话 → 理解 → 确认 → 分发 → 执行 → 核对 → 结果(V1 Thin Slice)</p>
      <ExecutiveConsole isCeo={isCeo} />
    </div>
  );
}
