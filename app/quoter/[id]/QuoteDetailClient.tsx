'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  exportQuoteSheet,
  duplicateQuote,
  convertQuoteToOrder,
  updateQuoteStatus,
  deleteQuote,
  submitQuoteFeedback,
} from '@/app/actions/quoter';
import { GARMENT_TYPE_LABELS } from '@/lib/quoter/types';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'bg-gray-100 text-gray-700' },
  sent: { label: '已发客户', color: 'bg-blue-100 text-blue-700' },
  won: { label: '成交', color: 'bg-green-100 text-green-700' },
  lost: { label: '丢单', color: 'bg-red-100 text-red-700' },
  abandoned: { label: '放弃', color: 'bg-amber-100 text-amber-700' },
};

interface Props {
  quote: any;
  feedback: any[];
  creatorName: string;
}

export function QuoteDetailClient({ quote: q, feedback, creatorName }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState('');
  const [fbType, setFbType] = useState<'fabric_consumption' | 'cmt_cost' | 'total_price'>('total_price');
  const [fbValue, setFbValue] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const sc = STATUS_CONFIG[q.status] || STATUS_CONFIG.draft;

  async function handleExport() {
    setLoading('export');
    const res = await exportQuoteSheet(q.id);
    if (res.error) { alert(res.error); setLoading(''); return; }
    if (res.base64 && res.fileName) {
      const byteChars = atob(res.base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }
    setLoading('');
  }

  async function handleDuplicate() {
    setLoading('dup');
    const res = await duplicateQuote(q.id);
    if (res.error) { alert(res.error); setLoading(''); return; }
    alert(`✅ 已复制为 ${res.newQuoteNo}`);
    router.push(`/quoter/${res.newQuoteId}`);
  }

  async function handleConvert() {
    if (!confirm('确认成交？将标记为 won 并跳转创建订单页面。')) return;
    setLoading('convert');
    const res = await convertQuoteToOrder(q.id);
    if (res.error) { alert(res.error); setLoading(''); return; }
    if (res.orderId) router.push(res.orderId);
  }

  async function handleStatusChange(status: string) {
    await updateQuoteStatus(q.id, status as any);
    router.refresh();
  }

  async function handleDelete() {
    if (!confirm(`删除报价 ${q.quote_no}？不可恢复。`)) return;
    await deleteQuote(q.id);
    router.push('/quoter');
  }

  async function handleFeedback() {
    if (!fbValue) return;
    const res = await submitQuoteFeedback(q.id, fbType, Number(fbValue));
    if (res.error) alert(res.error);
    else { alert('✅ 反馈已提交'); setShowFeedback(false); setFbValue(''); router.refresh(); }
  }

  const rate = q.exchange_rate || 7.2;
  const currency = q.currency || 'USD';

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{q.quote_no}</h1>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${sc.color}`}>{sc.label}</span>
          </div>
          <p className="text-sm text-gray-500">
            {q.customer_name || '未知客户'} · {q.style_no || '—'} {q.style_name || ''} · {q.quantity || 0} 件
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {creatorName} · {new Date(q.created_at).toLocaleDateString('zh-CN')}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleExport} disabled={loading === 'export'}
            className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium disabled:opacity-50">
            {loading === 'export' ? '导出中...' : '📥 导出 Excel'}
          </button>
          <button onClick={handleDuplicate} disabled={loading === 'dup'}
            className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 font-medium disabled:opacity-50">
            📋 复制报价
          </button>
          {q.status === 'draft' && (
            <button onClick={() => handleStatusChange('sent')}
              className="text-xs px-3 py-2 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 font-medium">
              📤 标记已发
            </button>
          )}
          {(q.status === 'sent' || q.status === 'draft') && (
            <button onClick={handleConvert} disabled={loading === 'convert'}
              className="text-xs px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium disabled:opacity-50">
              ✅ 成交 → 创建订单
            </button>
          )}
        </div>
      </div>

      {/* 最终报价 */}
      <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 p-6 text-white">
        <div className="text-xs opacity-80 mb-1">最终报价 / 件</div>
        <div className="text-4xl font-bold">{currency} {q.quote_price_per_piece?.toFixed(3) || '—'}</div>
        <div className="text-xs opacity-80 mt-2">
          总额：{currency} {((q.quote_price_per_piece || 0) * (q.quantity || 0)).toLocaleString('en-US', { maximumFractionDigits: 2 })}
          {q.margin_rate && ` · 利润率 ${q.margin_rate}%`}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* 成本明细 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">成本拆解（RMB / 件）</h3>
          <div className="space-y-2 text-sm">
            {[
              ['面料', `${q.fabric_consumption_kg?.toFixed(3) || '?'} KG × ¥${q.fabric_price_per_kg || '?'}/KG`, q.fabric_cost_per_piece],
              ['加工费', q.cmt_operations ? `${(q.cmt_operations as any[]).length} 道工序` : '', q.cmt_cost_per_piece],
              ['辅料', '', q.trim_cost_per_piece],
              ['包装', '', q.packing_cost_per_piece],
              ['物流', '', q.logistics_cost_per_piece],
            ].map(([label, desc, cost]) => (
              <div key={label as string} className="flex justify-between">
                <span className="text-gray-500">{label} <span className="text-xs text-gray-400">{desc}</span></span>
                <span className="font-mono">¥{(cost as number)?.toFixed(2) || '0.00'}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold">
              <span>小计</span>
              <span className="font-mono">¥{q.total_cost_per_piece?.toFixed(2) || '—'}</span>
            </div>
          </div>
        </div>

        {/* 款式信息 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">款式信息</h3>
          <div className="space-y-2 text-sm">
            {[
              ['品类', GARMENT_TYPE_LABELS[q.garment_type as keyof typeof GARMENT_TYPE_LABELS] || q.garment_type],
              ['款号', q.style_no || '—'],
              ['名称', q.style_name || '—'],
              ['面料', `${q.fabric_type || '—'} · ${q.fabric_composition || '—'}`],
              ['幅宽', q.fabric_width_cm ? `${q.fabric_width_cm} cm` : '—'],
              ['汇率', `1 USD = ¥${rate}`],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <span className="text-gray-500">{label}</span>
                <span className="text-gray-900">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 工序明细 */}
      {q.cmt_operations && (q.cmt_operations as any[]).length > 0 && (
        <details className="bg-white rounded-xl border border-gray-200 p-5">
          <summary className="text-sm font-semibold text-gray-800 cursor-pointer">
            ✂️ 工序明细（{(q.cmt_operations as any[]).length} 道）
          </summary>
          <div className="mt-3 max-h-48 overflow-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50"><th className="px-3 py-2 text-left">工序</th><th className="px-3 py-2 text-right">工价</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {(q.cmt_operations as any[]).map((op: any, i: number) => (
                  <tr key={i}><td className="px-3 py-1.5">{op.name}</td><td className="px-3 py-1.5 text-right font-mono">¥{(op.adjusted_rate || op.rate || 0).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* 训练反馈 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-800">📝 训练反馈</h3>
          <button onClick={() => setShowFeedback(!showFeedback)}
            className="text-xs text-indigo-600 hover:text-indigo-700">
            {showFeedback ? '收起' : '+ 提交反馈'}
          </button>
        </div>
        {showFeedback && (
          <div className="mb-4 p-3 bg-indigo-50 rounded-lg space-y-2">
            <p className="text-xs text-gray-600">报价成交后，填入实际成交价帮助系统校准：</p>
            <div className="flex gap-2">
              <select value={fbType} onChange={e => setFbType(e.target.value as any)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs bg-white">
                <option value="total_price">最终成交价/件</option>
                <option value="fabric_consumption">实际单耗 KG</option>
                <option value="cmt_cost">实际加工费 ¥</option>
              </select>
              <input type="number" step="0.001" value={fbValue} onChange={e => setFbValue(e.target.value)}
                placeholder="实际值" className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs" />
              <button onClick={handleFeedback} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700">
                提交
              </button>
            </div>
          </div>
        )}
        {feedback.length === 0 ? (
          <p className="text-xs text-gray-400">暂无反馈。成交后填入实际成交价，系统会越来越准。</p>
        ) : (
          <div className="space-y-1">
            {feedback.map((fb: any) => (
              <div key={fb.id} className="flex justify-between text-xs border-b border-gray-50 py-1">
                <span className="text-gray-500">
                  {fb.feedback_type === 'total_price' ? '成交价' : fb.feedback_type === 'cmt_cost' ? '加工费' : '单耗'}
                </span>
                <span>
                  预测 {fb.predicted_value} → 实际 {fb.actual_value}
                  <span className={`ml-2 font-medium ${Math.abs(fb.error_pct) > 10 ? 'text-red-600' : 'text-green-600'}`}>
                    {fb.error_pct > 0 ? '+' : ''}{fb.error_pct}%
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 状态变更 + 删除 */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-200">
        <div className="flex gap-2">
          {q.status !== 'lost' && <button onClick={() => handleStatusChange('lost')} className="text-xs px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 border border-red-200">标记丢单</button>}
          {q.status !== 'abandoned' && <button onClick={() => handleStatusChange('abandoned')} className="text-xs px-3 py-1.5 rounded-lg text-amber-600 hover:bg-amber-50 border border-amber-200">标记放弃</button>}
        </div>
        <button onClick={handleDelete} className="text-xs px-3 py-1.5 rounded-lg text-red-500 hover:bg-red-50">🗑 删除</button>
      </div>
    </div>
  );
}
