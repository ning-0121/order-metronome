import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { FormRulesClient } from './FormRulesClient';

export const dynamic = 'force-dynamic';

/**
 * 建单表单字段配置(2026-07-31,L2)。
 *
 * 让管理员自己配「哪个字段显示 / 要不要必填 / 默认值」,不用改代码 —— 这是把系统从
 * "绮陌专用"推向"可适配不同客户"的第一块可操作面板。
 * 代码默认在 lib/domain/formRules.ts,本页只管**差异**。
 */
export default async function FormRulesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: prof } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-6 text-center text-rose-600">
          仅管理员可配置建单表单字段
        </div>
      </div>
    );
  }

  const { data: customers } = await (supabase.from('customers') as any)
    .select('id, customer_name').order('customer_name', { ascending: true });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-1">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-indigo-600">← 管理</Link>
      </div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">🧩 建单表单字段配置</h1>
      <p className="text-sm text-gray-500 mb-5">
        配「哪些字段显示、哪些必填、默认填什么」。可全局配,也可只对某个客户配 —— 客户配置优先。
      </p>
      <FormRulesClient customers={(customers || []) as any} />
    </div>
  );
}
