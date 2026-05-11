'use client';

/**
 * RetrospectiveTab — 订单复盘摘要 + 快速评分入口
 *
 * 只在 lifecycle_status = completed/已完成/待复盘/已复盘 时挂载。
 * 不重复完整复盘表单，提供：
 *   1. 已有复盘 → 摘要卡片 + 四个快速评分字段（可独立保存）
 *   2. 无复盘   → 引导卡 + 链接到 /orders/[id]/retrospective
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getRetrospective } from '@/app/actions/orders';
import { saveRetrospectiveRatings } from '@/app/actions/retrospective-ratings';

interface Props {
  orderId: string;
  orderNo: string;
  isOwnerOrAdmin: boolean;
}

const DELAY_REASON_LABELS: Record<string, string> = {
  customer: '客户原因', supplier: '供应商原因', internal: '内部原因',
  logistics: '物流', other: '其他',
};

function StarRating({ value, onChange, disabled }: {
  value: number; onChange: (v: number) => void; disabled: boolean
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onChange(n)}
          className={`text-xl transition-colors ${
            n <= value ? 'text-amber-400' : 'text-gray-200 hover:text-amber-200'
          } disabled:cursor-default`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export function RetrospectiveTab({ orderId, orderNo, isOwnerOrAdmin }: Props) {
  const [retro, setRetro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 快速评分字段
  const [customerSatisfaction, setCustomerSatisfaction] = useState(0);
  const [factoryRating, setFactoryRating] = useState(0);
  const [willRepeatCustomer, setWillRepeatCustomer] = useState<boolean | null>(null);
  const [willRepeatFactory, setWillRepeatFactory] = useState<boolean | null>(null);

  useEffect(() => {
    getRetrospective(orderId).then(res => {
      if (res.data) {
        const d = res.data as any;
        setRetro(d);
        setCustomerSatisfaction(d.customer_satisfaction ?? 0);
        setFactoryRating(d.factory_rating ?? 0);
        setWillRepeatCustomer(d.will_repeat_customer ?? null);
        setWillRepeatFactory(d.will_repeat_factory ?? null);
      }
      setLoading(false);
    });
  }, [orderId]);

  async function handleSaveRatings() {
    setSaving(true);
    const res = await saveRetrospectiveRatings(orderId, {
      customer_satisfaction: customerSatisfaction || null,
      factory_rating: factoryRating || null,
      will_repeat_customer: willRepeatCustomer,
      will_repeat_factory: willRepeatFactory,
    });
    setSaving(false);
    if (!res.error) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      alert(res.error);
    }
  }

  if (loading) return <div className="py-12 text-center text-gray-400 text-sm">加载中…</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      {/* ── 无复盘时的引导卡 ── */}
      {!retro && (
        <div className="rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50 p-6 text-center">
          <div className="text-3xl mb-2">📋</div>
          <h3 className="text-base font-semibold text-indigo-900 mb-1">订单复盘尚未完成</h3>
          <p className="text-sm text-indigo-700 mb-4">
            复盘是提升的起点。记录关键问题、根本原因、改进措施，帮助团队下次做得更好。
          </p>
          {isOwnerOrAdmin && (
            <Link
              href={`/orders/${orderId}/retrospective`}
              className="inline-block px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              开始复盘
            </Link>
          )}
        </div>
      )}

      {/* ── 已有复盘摘要 ── */}
      {retro && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">复盘摘要</h3>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                retro.on_time_delivery === true
                  ? 'bg-green-100 text-green-700'
                  : retro.on_time_delivery === false
                  ? 'bg-red-100 text-red-700'
                  : 'bg-gray-100 text-gray-500'
              }`}>
                {retro.on_time_delivery === true ? '准时交付' : retro.on_time_delivery === false ? '延误交付' : '未记录'}
              </span>
              {retro.major_delay_reason && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                  {DELAY_REASON_LABELS[retro.major_delay_reason] ?? retro.major_delay_reason}
                </span>
              )}
              {isOwnerOrAdmin && (
                <Link
                  href={`/orders/${orderId}/retrospective`}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  编辑完整复盘 →
                </Link>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 text-sm">
            {retro.key_issue && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-0.5">关键问题</p>
                <p className="text-gray-800 leading-relaxed">{retro.key_issue}</p>
              </div>
            )}
            {retro.root_cause && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-0.5">根本原因</p>
                <p className="text-gray-800 leading-relaxed">{retro.root_cause}</p>
              </div>
            )}
            {retro.what_worked && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-0.5">做得好的地方</p>
                <p className="text-gray-800 leading-relaxed">{retro.what_worked}</p>
              </div>
            )}
          </div>

          {Array.isArray(retro.improvement_actions) && retro.improvement_actions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">改进措施</p>
              <ul className="space-y-1">
                {retro.improvement_actions.slice(0, 3).map((a: any, i: number) => (
                  <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                    <span className="text-indigo-400 shrink-0">•</span>
                    <span>{a.action || '—'}{a.owner_role ? ` (${a.owner_role})` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── 快速评分（无论有无复盘都可填写）── */}
      {isOwnerOrAdmin && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-800">快速评分</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">客户满意度</p>
              <StarRating value={customerSatisfaction} onChange={setCustomerSatisfaction} disabled={saving} />
              <p className="text-xs text-gray-400 mt-1">
                {['', '非常不满意', '不满意', '一般', '满意', '非常满意'][customerSatisfaction] || ''}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">工厂执行评分</p>
              <StarRating value={factoryRating} onChange={setFactoryRating} disabled={saving} />
              <p className="text-xs text-gray-400 mt-1">
                {['', '极差', '较差', '一般', '良好', '优秀'][factoryRating] || ''}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">是否继续合作（客户）</p>
              <div className="flex gap-2">
                {([true, false] as const).map(v => (
                  <button key={String(v)} type="button" disabled={saving}
                    onClick={() => setWillRepeatCustomer(willRepeatCustomer === v ? null : v)}
                    className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                      willRepeatCustomer === v
                        ? v ? 'bg-green-600 text-white border-green-600' : 'bg-red-500 text-white border-red-500'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {v ? '继续' : '不再'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">是否继续用该工厂</p>
              <div className="flex gap-2">
                {([true, false] as const).map(v => (
                  <button key={String(v)} type="button" disabled={saving}
                    onClick={() => setWillRepeatFactory(willRepeatFactory === v ? null : v)}
                    className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                      willRepeatFactory === v
                        ? v ? 'bg-green-600 text-white border-green-600' : 'bg-red-500 text-white border-red-500'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {v ? '继续' : '更换'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveRatings}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
            >
              {saving ? '保存中…' : saved ? '✓ 已保存' : '保存评分'}
            </button>
            {!retro && isOwnerOrAdmin && (
              <Link
                href={`/orders/${orderId}/retrospective`}
                className="text-sm text-indigo-600 hover:underline"
              >
                填写完整复盘（关键问题 / 根因 / 改进措施）→
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
