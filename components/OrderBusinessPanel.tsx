'use client';

import { useState, useEffect } from 'react';
import { getOrderBusinessState } from '@/app/actions/order-business-state';
import type { OrderBusinessState, StatusLevel } from '@/lib/engine/orderBusinessEngine';

interface Props {
  orderId: string;
  isAdmin: boolean;
  userRoles: string[];
}

const LEVEL_STYLES: Record<StatusLevel, { bg: string; text: string; border: string; badge: string }> = {
  green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', badge: 'bg-green-100 text-green-800' },
  yellow: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', badge: 'bg-amber-100 text-amber-800' },
  red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', badge: 'bg-red-100 text-red-800' },
  gray: { bg: 'bg-gray-50', text: 'text-gray-500', border: 'border-gray-200', badge: 'bg-gray-100 text-gray-600' },
};

const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' };
const PROFIT_LABELS: Record<string, string> = { healthy: '健康', low: '偏低', loss: '亏损', unknown: '待录入' };
const PAYMENT_LABELS: Record<string, string> = { received: '已收齐', partial: '部分收款', pending: '待收款', overdue: '逾期', hold: '暂停' };
const CONFIRM_ICONS: Record<string, string> = { fabric_color: '🧵', size_breakdown: '📏', logo_print: '🎨', packaging_label: '📦' };

export function OrderBusinessPanel({ orderId, isAdmin, userRoles }: Props) {
  const [state, setState] = useState<OrderBusinessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canSeeFinancials = isAdmin || userRoles.some(r => ['finance', 'production_manager'].includes(r));

  useEffect(() => {
    setLoading(true);
    getOrderBusinessState(orderId)
      .then(res => {
        if (res.error) setError(res.error);
        else setState(res.data || null);
      })
      .catch(() => setError('加载失败'))
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading) return <Skeleton />;
  if (error) return (
    <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 text-sm text-gray-500 mb-6">
      经营数据加载失败：{error}
    </div>
  );
  if (!state) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
      {/* 利润卡 */}
      {canSeeFinancials ? (
        <ProfitCard state={state} />
      ) : (
        <ProfitCardLite state={state} />
      )}
      {/* 收款卡 */}
      <PaymentCard state={state} canSeeFinancials={canSeeFinancials} />
      {/* 风险卡 */}
      <RiskCard state={state} />
      {/* 确认链 */}
      <ConfirmationCard state={state} />
    </div>
  );
}

// ═══════════════════════════════════════════════
// 利润卡（完整版 — admin/finance）
// ═══════════════════════════════════════════════
function ProfitCard({ state }: { state: OrderBusinessState }) {
  const s = LEVEL_STYLES[state.order_profit_status.level];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">💰 利润</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badge}`}>
          {PROFIT_LABELS[state.order_profit_status.value] || state.order_profit_status.value}
        </span>
      </div>
      {state.margin_pct !== null ? (
        <>
          <div className="text-2xl font-bold text-gray-900">{state.margin_pct}%</div>
          <div className="text-xs text-gray-600 mt-1">
            毛利 ¥{(state.gross_profit_rmb || 0).toLocaleString()}
          </div>
          {state.order_profit_status.overridden && (
            <div className="text-[10px] text-indigo-600 mt-1">管理员已批准</div>
          )}
        </>
      ) : (
        <div className="text-sm text-gray-400 mt-2">待录入销售额</div>
      )}
      <p className={`text-[11px] mt-2 leading-relaxed ${s.text}`}>{state.order_profit_status.explain}</p>
    </div>
  );
}

// 利润卡（简版 — 普通业务员）
function ProfitCardLite({ state }: { state: OrderBusinessState }) {
  const s = LEVEL_STYLES[state.order_profit_status.level];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">💰 利润状态</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badge}`}>
          {PROFIT_LABELS[state.order_profit_status.value] || state.order_profit_status.value}
        </span>
      </div>
      <div className="text-sm text-gray-600 mt-1">
        {state.order_profit_status.value === 'healthy' ? '利润正常' :
         state.order_profit_status.value === 'low' ? '利润偏低，请关注' :
         state.order_profit_status.value === 'loss' ? '此单可能亏损' : '待财务录入'}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// 收款卡
// ═══════════════════════════════════════════════
function PaymentCard({ state, canSeeFinancials }: { state: OrderBusinessState; canSeeFinancials: boolean }) {
  const s = LEVEL_STYLES[state.payment_status.level];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">💵 收款</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badge}`}>
          {PAYMENT_LABELS[state.payment_status.value] || state.payment_status.value}
        </span>
      </div>
      {state.overdue_payment_days > 0 && (
        <div className="text-2xl font-bold text-red-600">逾期 {state.overdue_payment_days} 天</div>
      )}
      <p className={`text-[11px] leading-relaxed ${s.text}`}>{state.payment_status.explain}</p>

      {/* 生产/出货控制 */}
      <div className="flex gap-3 mt-2 pt-2 border-t border-gray-200/50">
        <ControlBadge
          label="生产"
          allowed={state.can_proceed_production.value}
          overridden={state.can_proceed_production.overridden}
          explain={state.can_proceed_production.explain}
        />
        <ControlBadge
          label="出货"
          allowed={state.can_ship.value}
          overridden={state.can_ship.overridden}
          explain={state.can_ship.explain}
        />
      </div>
    </div>
  );
}

function ControlBadge({ label, allowed, overridden, explain }: {
  label: string; allowed: boolean; overridden?: boolean; explain: string;
}) {
  return (
    <div className="flex items-center gap-1" title={explain}>
      <span className={`w-2 h-2 rounded-full ${allowed ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className={`text-[10px] ${allowed ? 'text-green-700' : 'text-red-700'}`}>
        {label}{allowed ? '✓' : '✗'}
      </span>
      {overridden && <span className="text-[9px] text-indigo-500">已覆盖</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 风险卡
// ═══════════════════════════════════════════════
function RiskCard({ state }: { state: OrderBusinessState }) {
  const s = LEVEL_STYLES[state.hidden_risk_level.level];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">⚠ 风险</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badge}`}>
          {RISK_LABELS[state.hidden_risk_level.value] || state.hidden_risk_level.value}
        </span>
      </div>

      {/* 当前阻塞项 */}
      {state.current_business_blocker && (
        <div className="text-sm font-semibold text-red-800 mb-1">
          卡点：{state.current_business_blocker}
        </div>
      )}

      {/* 风险因素标签 */}
      {state.risk_factors.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {state.risk_factors.map((f, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-white/60 text-gray-700 border border-gray-200/60">
              {f}
            </span>
          ))}
        </div>
      )}

      {/* 延期预估 */}
      {state.estimated_delay_risk.value !== 'none' && (
        <p className={`text-[10px] ${LEVEL_STYLES[state.estimated_delay_risk.level].text}`}>
          {state.estimated_delay_risk.explain}
        </p>
      )}

      {state.risk_factors.length === 0 && (
        <p className="text-xs text-green-600">当前无明显风险</p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 确认链进度卡
// ═══════════════════════════════════════════════
function ConfirmationCard({ state }: { state: OrderBusinessState }) {
  const rate = state.confirmation_completion_rate;
  const barColor = rate === 100 ? 'bg-green-500' : rate >= 50 ? 'bg-amber-500' : rate > 0 ? 'bg-red-500' : 'bg-gray-300';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">✅ 确认链</span>
        <span className="text-xs font-bold text-gray-800">{rate}%</span>
      </div>

      {/* 进度条 */}
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-3">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${rate}%` }} />
      </div>

      {/* 4 模块状态 */}
      <div className="grid grid-cols-2 gap-1.5">
        {state.confirmation_details.map(d => {
          const s = LEVEL_STYLES[d.level];
          const statusLabel =
            d.status === 'confirmed' ? '已确认' :
            d.status === 'pending_customer' ? '待客户' :
            d.status === 'pending_internal' ? '待内部' :
            d.status === 'rejected' ? '已拒绝' :
            d.status === 'reconfirm_required' ? '需重确' :
            '未开始';
          return (
            <div key={d.module} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border ${s.bg} ${s.border}`}>
              <span className="text-sm">{CONFIRM_ICONS[d.module] || '📋'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium text-gray-800 truncate">{d.label}</div>
                <div className={`text-[9px] ${s.text}`}>{statusLabel}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 缺失项 */}
      {state.missing_confirmation_items.length > 0 && (
        <p className="text-[10px] text-red-600 mt-2">
          缺失：{state.missing_confirmation_items.join('、')}
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Skeleton Loading
// ═══════════════════════════════════════════════
function Skeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-gray-50 p-4 animate-pulse">
          <div className="flex justify-between mb-3">
            <div className="h-3 w-12 bg-gray-200 rounded" />
            <div className="h-4 w-14 bg-gray-200 rounded-full" />
          </div>
          <div className="h-6 w-16 bg-gray-200 rounded mb-2" />
          <div className="h-3 w-full bg-gray-200 rounded mb-1" />
          <div className="h-3 w-3/4 bg-gray-200 rounded" />
        </div>
      ))}
    </div>
  );
}
