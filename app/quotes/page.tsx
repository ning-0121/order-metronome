import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { QuoteActionButtons } from '@/components/QuoteActionButtons';

export default async function QuotesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { isAdmin } = await getCurrentUserRole(supabase);

  const { data: allQuotes } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, quantity, incoterm, order_type, order_purpose, quote_stage, quote_status, product_description, target_price, notes, created_at, parent_order_id')
    .in('order_purpose', ['inquiry', 'sample'])
    .order('created_at', { ascending: false });

  const quotes = allQuotes || [];

  // 按阶段分组
  const stages: Array<{ key: string; label: string; color: string; items: any[] }> = [
    { key: 'draft', label: '📝 草稿', color: 'border-gray-200', items: [] },
    { key: 'pending_review', label: '⏳ 待CEO审批', color: 'border-amber-200', items: [] },
    { key: 'approved', label: '✅ 已通过', color: 'border-green-200', items: [] },
    { key: 'sent_to_customer', label: '📤 已发客户', color: 'border-blue-200', items: [] },
    { key: 'customer_accepted', label: '🤝 客户接受', color: 'border-indigo-200', items: [] },
    { key: 'customer_revision', label: '🔄 客户要修改', color: 'border-orange-200', items: [] },
    { key: 'sample_created', label: '🧪 已创建打样', color: 'border-purple-200', items: [] },
    { key: 'customer_rejected', label: '❌ 客户放弃', color: 'border-red-200', items: [] },
    { key: 'order_created', label: '📦 已下单', color: 'border-green-300', items: [] },
  ];

  for (const q of quotes) {
    const stage = stages.find(s => s.key === (q.quote_stage || 'draft'));
    if (stage) stage.items.push(q);
    else stages[0].items.push(q); // 默认放草稿
  }

  const activeStages = stages.filter(s => s.items.length > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">报价管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            报价 {quotes.filter(q => q.order_purpose === 'inquiry').length} 个 · 打样 {quotes.filter(q => q.order_purpose === 'sample').length} 个
          </p>
        </div>
        <Link href="/quotes/new" className="btn-primary inline-flex items-center gap-2">+ 新建报价单</Link>
      </div>

      {/* 流程说明 */}
      <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-4 mb-6">
        <p className="text-sm text-indigo-800 font-medium mb-1">报价流程</p>
        <p className="text-xs text-indigo-600">新建报价 → 上传资料 → 提交审批 → CEO通过 → 发给客户 → 客户反馈 → 创建打样单 → 样品确认 → 正式下单</p>
      </div>

      {activeStages.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-400 mb-4">暂无报价记录</p>
          <Link href="/quotes/new" className="btn-primary">开始第一个报价</Link>
        </div>
      ) : (
        <div className="space-y-6">
          {activeStages.map(stage => (
            <div key={stage.key} className={`bg-white rounded-xl border ${stage.color} overflow-hidden`}>
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-bold text-gray-900">{stage.label}（{stage.items.length}）</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {stage.items.map((q: any) => (
                  <div key={q.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/orders/${q.id}`} className="font-semibold text-indigo-600 hover:underline">{q.order_no}</Link>
                          <span className="text-sm text-gray-600">{q.customer_name}</span>
                          {q.order_purpose === 'sample' && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">打样单</span>}
                          {q.quantity && <span className="text-xs text-gray-400">{q.quantity}件</span>}
                          {q.target_price && <span className="text-xs text-gray-400">目标价: {q.target_price}</span>}
                        </div>
                        {q.product_description && (
                          <p className="text-sm text-gray-500 mt-1 truncate">{q.product_description}</p>
                        )}
                        <p className="text-xs text-gray-400 mt-1">{formatDate(q.created_at)}</p>
                      </div>
                      <QuoteActionButtons quoteId={q.id} orderNo={q.order_no} stage={q.quote_stage || 'draft'} isAdmin={isAdmin} orderPurpose={q.order_purpose} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
