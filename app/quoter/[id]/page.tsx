import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { QuoteDetailClient } from './QuoteDetailClient';

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: quote } = await (supabase.from('quoter_quotes') as any)
    .select('*').eq('id', id).single();

  if (!quote) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center">
        <p className="text-gray-500 mb-4">报价不存在</p>
        <Link href="/quoter" className="text-indigo-600 hover:underline">返回报价列表</Link>
      </div>
    );
  }

  // 获取训练反馈
  const { data: feedback } = await (supabase.from('quoter_training_feedback') as any)
    .select('*').eq('quote_id', id).order('created_at', { ascending: false });

  // 获取创建者名字
  let creatorName = '未知';
  if ((quote as any).created_by) {
    const { data: profile } = await (supabase.from('profiles') as any)
      .select('name, email').eq('user_id', (quote as any).created_by).single();
    creatorName = (profile as any)?.name || (profile as any)?.email?.split('@')[0] || '未知';
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/quoter" className="text-sm text-gray-500 hover:text-indigo-600">← 报价列表</Link>
      </div>
      <QuoteDetailClient quote={quote as any} feedback={(feedback || []) as any[]} creatorName={creatorName} />
    </div>
  );
}
