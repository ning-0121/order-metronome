import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { NewQuoteForm } from './NewQuoteForm';

export default async function NewQuotePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">新建报价</h1>
        <p className="text-sm text-gray-500 mt-1">
          填完款式 + 尺码 + 面料参数 → AI 自动计算单耗 + 加工费 → 预览报价 → 确认保存
        </p>
      </div>
      <NewQuoteForm />
    </div>
  );
}
