'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface RiskOrder {
  id: string;
  orderNo: string;
  customerName: string;
  factoryName: string;
  quantity: number | null;
  factoryDate: string | null;
  etd: string | null;
  lifecycleStatus: string;
  overdueCount: number;
  blockedCount: number;
  overdueNames: string[];
  blockedNames: string[];
  riskColor: string;
  riskReason: string;
}

export function RiskOrderList({ orders }: { orders: RiskOrder[] }) {
  const [memoOrder, setMemoOrder] = useState<RiskOrder | null>(null);
  const pathname = usePathname();
  const fromParam = encodeURIComponent(pathname);

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
        ✨ 没有符合条件的订单
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {orders.map(o => {
        const colorClasses: Record<string, string> = {
          RED: 'border-red-300 bg-red-50/30',
          YELLOW: 'border-yellow-300 bg-yellow-50/30',
          GREEN: 'border-green-300 bg-green-50/30',
        };
        return (
          <div
            key={o.id}
            className={`bg-white rounded-xl border-2 p-4 ${colorClasses[o.riskColor] || 'border-gray-200'}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* 订单基本信息 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-bold text-gray-900 text-lg">{o.orderNo}</span>
                  <span className="text-sm text-gray-500">·</span>
                  <span className="text-sm text-gray-700">{o.customerName}</span>
                  {o.factoryName !== '—' && (
                    <>
                      <span className="text-sm text-gray-500">·</span>
                      <span className="text-sm text-gray-500">{o.factoryName}</span>
                    </>
                  )}
                </div>

                {/* 订单关键数据 */}
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                  {o.quantity && <span>📦 {o.quantity}件</span>}
                  {o.factoryDate && <span>🏭 出厂 {o.factoryDate}</span>}
                  {o.etd && <span>🚢 ETD {o.etd}</span>}
                  <span className="px-2 py-0.5 bg-gray-100 rounded">{o.lifecycleStatus}</span>
                </div>

                {/* 风险详情 */}
                {o.overdueCount > 0 && (
                  <div className="mt-2 text-sm">
                    <span className="font-medium text-red-700">🔴 {o.overdueCount} 个逾期节点：</span>
                    <span className="text-gray-600">{o.overdueNames.join('、')}</span>
                    {o.overdueCount > 3 && <span className="text-gray-400"> 等</span>}
                  </div>
                )}
                {o.blockedCount > 0 && (
                  <div className="mt-1 text-sm">
                    <span className="font-medium text-orange-700">🔒 {o.blockedCount} 个阻塞节点：</span>
                    <span className="text-gray-600">{o.blockedNames.join('、')}</span>
                    {o.blockedCount > 3 && <span className="text-gray-400"> 等</span>}
                  </div>
                )}
                {o.riskReason && (
                  <div className="mt-1 text-xs text-gray-500 italic">{o.riskReason}</div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex flex-col gap-2 shrink-0">
                <Link
                  href={`/orders/${o.id}?from=${fromParam}`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700"
                >
                  📋 处理
                </Link>
                <button
                  onClick={() => setMemoOrder(o)}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-amber-300 text-amber-700 px-4 py-2 text-sm font-medium hover:bg-amber-50"
                >
                  ⏰ 加入备忘录
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {memoOrder && <MemoModal order={memoOrder} onClose={() => setMemoOrder(null)} />}
    </div>
  );
}

function MemoModal({ order, onClose }: { order: RiskOrder; onClose: () => void }) {
  const [content, setContent] = useState(
    `跟进 ${order.orderNo}（${order.customerName}）— ${order.overdueCount > 0 ? `${order.overdueCount}个逾期` : ''}${order.blockedCount > 0 ? ` ${order.blockedCount}个阻塞` : ''}`
  );
  const [remindAt, setRemindAt] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      alert('请先登录');
      return;
    }

    const { error } = await (supabase.from('user_memos') as any).insert({
      user_id: user.id,
      content,
      remind_at: remindAt ? new Date(remindAt).toISOString() : null,
      is_done: false,
    });

    if (error) {
      alert('保存失败：' + error.message);
      setSaving(false);
      return;
    }

    setSuccess(true);
    setSaving(false);
    setTimeout(() => onClose(), 1500);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-900">⏰ 加入备忘录</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        {success ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-2">✅</div>
            <p className="text-sm text-gray-600">已加入备忘录，到时会提醒你</p>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">备忘内容</label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">提醒时间</label>
              <input
                type="datetime-local"
                value={remindAt}
                onChange={e => setRemindAt(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
              <div className="flex gap-2 mt-2">
                {[
                  { label: '1小时后', hours: 1 },
                  { label: '今晚18:00', custom: () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d; } },
                  { label: '明天上午', custom: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
                  { label: '后天上午', custom: () => { const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(9, 0, 0, 0); return d; } },
                ].map(preset => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      const d = preset.custom ? preset.custom() : new Date(Date.now() + (preset.hours || 0) * 3600000);
                      setRemindAt(d.toISOString().slice(0, 16));
                    }}
                    className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !content.trim()}
                className="flex-1 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存到备忘录'}
              </button>
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
