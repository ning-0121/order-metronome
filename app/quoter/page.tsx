import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listQuotes } from '@/app/actions/quoter';
import { GARMENT_TYPE_LABELS } from '@/lib/quoter/types';

export default async function QuoterHomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: quotes, error } = await listQuotes(30);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-center text-red-600">
          {error}
        </div>
      </div>
    );
  }

  const STATUS_COLORS: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700 border-gray-200',
    sent: 'bg-blue-100 text-blue-700 border-blue-200',
    won: 'bg-green-100 text-green-700 border-green-200',
    lost: 'bg-red-100 text-red-700 border-red-200',
    abandoned: 'bg-amber-100 text-amber-700 border-amber-200',
  };
  const STATUS_LABELS: Record<string, string> = {
    draft: '草稿',
    sent: '已发',
    won: '成交',
    lost: '丢单',
    abandoned: '放弃',
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white text-2xl">
            💰
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">报价员</h1>
            <p className="text-sm text-gray-500">
              AI 辅助面料单耗 + 加工费计算 · 独立模块
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/quoter/training"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-50 text-purple-700 border border-purple-200 text-sm font-medium hover:bg-purple-100"
          >
            📚 训练数据
          </Link>
          <Link
            href="/quoter/new"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新建报价
          </Link>
        </div>
      </div>

      {/* 简介卡片 */}
      <div className="mb-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="text-2xl mb-2">🧵</div>
          <h3 className="font-semibold text-gray-900 text-sm mb-1">面料单耗 AI</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            根据尺码表 + 面料参数 + 历史数据智能推算每件用料，无需排料软件。
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="text-2xl mb-2">✂️</div>
          <h3 className="font-semibold text-gray-900 text-sm mb-1">加工费 AI</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            自动按工序拆解 + 工价累加，Phase 2 会加图片识别自动判断复杂度。
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="text-2xl mb-2">📚</div>
          <h3 className="font-semibold text-gray-900 text-sm mb-1">训练反馈闭环</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            每次报价后对比实际成交价，系统会记录偏差并逐步校准公式参数。
          </p>
        </div>
      </div>

      {/* 报价列表 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">近期报价</h2>
          <span className="text-xs text-gray-400">{(quotes || []).length} 条</span>
        </div>
        {!quotes || quotes.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            <p className="mb-3">暂无报价</p>
            <Link
              href="/quoter/new"
              className="inline-block text-indigo-600 hover:underline text-sm"
            >
              创建第一个报价 →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">报价号</th>
                  <th className="px-4 py-2 font-medium">客户</th>
                  <th className="px-4 py-2 font-medium">款号</th>
                  <th className="px-4 py-2 font-medium">品类</th>
                  <th className="px-4 py-2 font-medium text-center">数量</th>
                  <th className="px-4 py-2 font-medium text-right">单耗 (KG)</th>
                  <th className="px-4 py-2 font-medium text-right">加工费</th>
                  <th className="px-4 py-2 font-medium text-right">报价 / 件</th>
                  <th className="px-4 py-2 font-medium text-center">状态</th>
                  <th className="px-4 py-2 font-medium">创建</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {quotes.map((q: any) => (
                  <tr key={q.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-xs text-indigo-600">
                      {q.quote_no}
                    </td>
                    <td className="px-4 py-2.5">{q.customer_name || '-'}</td>
                    <td className="px-4 py-2.5 text-gray-500">{q.style_no || '-'}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {GARMENT_TYPE_LABELS[q.garment_type as keyof typeof GARMENT_TYPE_LABELS] || q.garment_type}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-700">
                      {q.quantity || 0}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      {q.fabric_consumption_kg?.toFixed(3) || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      ¥{q.cmt_cost_per_piece?.toFixed(2) || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-indigo-700">
                      {q.currency} {q.quote_price_per_piece?.toFixed(3) || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full border ${
                          STATUS_COLORS[q.status] || STATUS_COLORS.draft
                        }`}
                      >
                        {STATUS_LABELS[q.status] || q.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-400">
                      {q._creator_name} · {new Date(q.created_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
