import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getProcurementQueues, getProcurementMatters, type RiskMatter } from '@/app/actions/procurement';
import { ProcurementQueueClient } from '@/components/ProcurementQueueClient';

/**
 * 采购中心（Procurement Center）V1 — 工作队列页 + 风险中心。
 * 队列：待下单 / 待催货 / 待验收（跨订单聚合，订单是主线）。
 * 风险中心：只读，读 nightly cron 物化的 procurement_matters（设计 §3.6 §8）。
 * 数据/权限由 action 把关（ALLOWED_ROLES 可看；写操作 action 内再校验采购/管理员）。
 */
const MATTER_GROUPS: { type: RiskMatter['matter_type']; label: string; tone: string }[] = [
  { type: 'material_shortage', label: '🧵 缺料风险', tone: 'border-red-200 bg-red-50' },
  { type: 'supplier_delay', label: '⏰ 供应商延期', tone: 'border-amber-200 bg-amber-50' },
  { type: 'chase_stalled', label: '🔁 催货停滞', tone: 'border-amber-200 bg-amber-50' },
  { type: 'quality_reject', label: '❌ 质量拒收/让步', tone: 'border-red-200 bg-red-50' },
  { type: 'price_anomaly', label: '💰 价格异常', tone: 'border-purple-200 bg-purple-50' },
  { type: 'risk_schedule', label: '📅 排期风险', tone: 'border-gray-200 bg-gray-50' },
];

export default async function ProcurementCenterPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const result = await getProcurementQueues();
  if (result.error) {
    // 无权限或查询失败：降级提示，不 crash
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="text-xl font-bold text-gray-900 mb-2">采购中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const { pendingRequests, pendingOrder, chase, readyShip, receive, counts } = result.data!;
  const mattersResult = await getProcurementMatters();
  const matters = mattersResult.data?.matters ?? [];
  const matterCounts = mattersResult.data?.counts ?? { total: 0, high: 0, medium: 0 };

  const Stat = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
    <div className={`rounded-xl border px-4 py-3 ${tone}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🛒 采购中心</h1>
          <p className="mt-1 text-sm text-gray-500">订单是主线 · 待下单 / 待催货 / 待验收 · 风险中心</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/suppliers" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            🏢 供应商
          </Link>
          <Link href="/procurement/cost" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            💰 成本核算
          </Link>
          <Link href="/procurement/inventory" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            📦 库存
          </Link>
          <Link href="/procurement/po/new" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            ＋ 新建采购单
          </Link>
        </div>
      </div>

      {/* Dashboard 壳：计数 */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-6">
        <Stat label="📨 待采购订单" value={counts.pendingRequests} tone="border-emerald-300 bg-emerald-50 text-emerald-800" />
        <Stat label="待下单" value={counts.pendingOrder} tone="border-indigo-200 bg-indigo-50 text-indigo-800" />
        <Stat label="待催货 / 生产中" value={counts.chase} tone="border-amber-200 bg-amber-50 text-amber-800" />
        <Stat label="已完成待送货" value={counts.readyShip} tone="border-sky-200 bg-sky-50 text-sky-800" />
        <Stat label="已送达待验收" value={counts.receive} tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
        <Stat label="🔴 红灯行" value={counts.red} tone="border-red-200 bg-red-50 text-red-800" />
        <Stat label="⚠️ 风险事项" value={matterCounts.total} tone="border-rose-200 bg-rose-50 text-rose-800" />
      </div>

      <ProcurementQueueClient pendingRequests={pendingRequests} pendingOrder={pendingOrder} chase={chase} readyShip={readyShip} receive={receive} />

      {/* ── 风险中心（只读，物化投影）── */}
      <div className="mt-8">
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900">⚠️ 采购风险中心</h2>
          <span className="text-xs text-gray-400">
            {matterCounts.total > 0
              ? `高 ${matterCounts.high} · 中 ${matterCounts.medium}（每日自动物化）`
              : '每日自动物化'}
          </span>
        </div>
        <RiskCenter matters={matters} />
      </div>
    </div>
  );
}

function RiskCenter({ matters }: { matters: RiskMatter[] }) {
  if (matters.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
        暂无采购风险事项（每日定时物化；如刚上线，等下一次每日任务或由管理员手动触发后显示）。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {MATTER_GROUPS.map(({ type, label, tone }) => {
        const group = matters.filter(m => m.matter_type === type);
        if (group.length === 0) return null;
        return (
          <section key={type} className={`rounded-xl border overflow-hidden ${tone}`}>
            <div className="px-4 py-2.5 border-b border-black/5 font-bold text-gray-800 text-sm">
              {label}（{group.length}）
            </div>
            <div className="bg-white/60">
              {group.map(m => (
                <div key={m.id} className="border-b border-gray-100 last:border-0 px-4 py-2.5 flex items-start gap-2">
                  <span
                    className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      m.severity === 'high'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {m.severity === 'high' ? '高' : '中'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900">{m.title}</div>
                    <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-2">
                      {m.order_id && m.order_no && (
                        <Link href={`/orders/${m.order_id}`} className="text-indigo-600 hover:underline">
                          {m.order_no}
                        </Link>
                      )}
                      <span>检出 {m.detected_at?.slice(0, 10)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
