'use client';

/**
 * 订单头 ↔ 明细 不一致横幅(2026-08-13)
 *
 * 为什么要有它:1022982 / 1022969 两张真实单都卡在同一个状态 ——
 * 明细已按新 PO 更新(可信真相),订单头/金额还是旧值。员工看不出问题在哪,
 * 于是去点「订单修改申请 · 减少数量/增加数量」,一个被明细闸拦、一个被采购窗口锁,
 * 折腾一整天数量还是没变。
 *
 * 产品原则:**系统发现自己的真相层分叉,应该主动说出来并给一键自愈**,
 * 而不是让员工在四个入口里猜该点哪个。
 *
 * 这个操作只对齐订单头 / 金额 / 财务,**不修改任何颜色尺码明细**。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { correctOrderQuantity } from '@/app/actions/order-quantity-correction';

export interface HeaderReconciliationState {
  mismatch: boolean;
  headerQty?: number | null;
  commercialQty?: number;
  physicalQty?: number;
  oldAmount?: number | null;
  newAmount?: number | null;
  canFix?: boolean;
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export function HeaderReconciliationBanner({
  orderId, state,
}: { orderId: string; state: HeaderReconciliationState }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);

  if (!state?.mismatch || done) return null;

  const { headerQty, commercialQty, physicalQty, oldAmount, newAmount, canFix } = state;
  const isSet = (commercialQty ?? 0) > 0 && physicalQty !== commercialQty;

  async function apply() {
    setBusy(true); setMsg('');
    // 服务端会再校验一次「请求件数 == 明细物理合计 且 != 订单头」才允许走自愈通道
    const r = await correctOrderQuantity({
      orderId, newTotalQty: physicalQty!, revenueMode: 'keep',
      reason: '订单头与明细不一致,一键对齐订单头',
    });
    setBusy(false);
    if ((r as any).error) { setMsg((r as any).error); return; }
    setMsg((r as any).summary || '已对齐');
    setDone(true);
    setTimeout(() => router.refresh(), 900);
  }

  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none mt-0.5">⚠️</span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-bold text-amber-900">订单头与明细不一致</h4>

          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-gray-700">
            <span className="text-gray-500">订单头</span>
            <span><b className="text-red-600">{headerQty ?? '—'}</b> 件</span>
            <span className="text-gray-500">明细</span>
            <span>
              <b className="text-emerald-700">{commercialQty ?? '—'}</b> {isSet ? '套' : '件'}
              {isSet && <span className="text-gray-500">（折合 {physicalQty} 件）</span>}
            </span>
          </div>

          {/* 点击前必须看清会变什么、不会变什么 */}
          <div className="mt-3 rounded-lg bg-white/70 border border-amber-200 px-3 py-2 text-xs text-gray-700 space-y-0.5">
            <div className="font-medium text-gray-800">执行后:</div>
            <div>订单数量：<b>{headerQty ?? '—'}</b> → <b className="text-emerald-700">{physicalQty}</b></div>
            <div>订单金额：<b>{money(oldAmount)}</b> → <b className="text-emerald-700">{money(newAmount)}</b></div>
            <div>颜色/尺码明细：<b>不变</b></div>
          </div>

          <p className="mt-2 text-xs text-amber-800">
            本操作<b>只对齐订单头、金额及关联财务数据,不修改颜色/尺码明细</b>。
            如果是客户真的加量或减量,请走「订单修改申请」审批,不要用这里。
          </p>

          {msg && (
            <p className={`mt-2 text-xs ${done ? 'text-emerald-700' : 'text-red-600'}`}>{msg}</p>
          )}

          {canFix ? (
            <button
              onClick={apply}
              disabled={busy}
              className="mt-3 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? '对齐中…' : '一键对齐订单头'}
            </button>
          ) : (
            <p className="mt-3 text-xs text-gray-500">请联系跟单 / 业务执行经理执行对齐。</p>
          )}
        </div>
      </div>
    </div>
  );
}
