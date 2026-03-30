import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function MyAssistantPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-3xl mx-auto mb-6">
        💬
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">我的助手</h1>
      <p className="text-gray-500 mb-8">
        AI 助手即将上线，帮助你快速查询订单状态、回答流程问题。
      </p>
      <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-12">
        <p className="text-gray-400 text-sm">功能开发中，敬请期待</p>
      </div>
    </div>
  );
}
