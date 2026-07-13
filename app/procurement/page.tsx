import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getProcurementQueues, getProcurementMatters, type RiskMatter } from '@/app/actions/procurement';
import { ProcurementQueueClient } from '@/components/ProcurementQueueClient';
import { RiskEtaFill } from './RiskEtaFill';
import { DraftPOBanner } from './DraftPOBanner';

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
  const { roles: pageRoles } = await requireProcurementPage();   // 采购系统页面级门禁:非采购角色回工作台(2026-07-03)
  const canFinanceOver = pageRoles.some(r => ['finance', 'admin'].includes(r));   // 超收放行仅财务/管理员
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 两个独立调用并行(原串行 → 少一整轮跨区往返;性能优化 2026-07-04)
  const [result, mattersResult] = await Promise.all([getProcurementQueues(), getProcurementMatters()]);
  if (result.error) {
    // 无权限或查询失败：降级提示，不 crash
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="text-xl font-bold text-gray-900 mb-2">采购中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const { pendingRequests, pendingOrder, chase, readyShip, receive, counts, pendingApprovalPOs } = result.data!;
  const matters = mattersResult.data?.matters ?? [];
  const matterCounts = mattersResult.data?.counts ?? { total: 0, high: 0, medium: 0 };
  const canProcure = pageRoles.some(r => ['admin', 'procurement', 'procurement_manager'].includes(r));   // 采购可删草稿单

  // ⏳ 草稿采购单箱:客户端组件(删除草稿/疑重复警示需交互),渲染在「计数卡 → 队列」之间
  const banner = pendingApprovalPOs.length > 0
    ? <DraftPOBanner pos={pendingApprovalPOs} canDelete={canProcure} />
    : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold text-gray-900 whitespace-nowrap">🛒 采购中心</h1>
          <p className="mt-1 text-sm text-gray-500 whitespace-nowrap">订单是主线 · 待下单 / 待催货 / 待验收 · 风险中心</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Link href="/suppliers" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            🏢 供应商
          </Link>
          <Link href="/material-master" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            🧱 物料库
          </Link>
          <Link href="/procurement/cost" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            💰 成本核算
          </Link>
          <Link href="/procurement/inventory" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            📦 库存
          </Link>
          <Link href="/procurement/ledger" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50" title="导入《面料采购明细表汇总》→ 按供应商×订单归集应付,对接财务">
            📒 供应商对账台账
          </Link>
          <Link href="/procurement/receipts" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50" title="按供应商/物料筛选 → 导出收货对账单 Excel(日期/物料/规格/数量/收货地址/码单)发供应商对账">
            📥 收货对账单
          </Link>
          <Link href="/procurement/po" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50" title="全部采购单(含已入库历史单),按订单号/供应商调回">
            🧾 采购单档案
          </Link>
          <Link href="/procurement/po/new" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-500 border border-gray-200 text-sm hover:bg-gray-50" title="不走归并,手动勾行建单">
            手动建单
          </Link>
          <Link href="/procurement/netting" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            🧩 待采购工作台
          </Link>
        </div>
      </div>

      <ProcurementQueueClient pendingRequests={pendingRequests} pendingOrder={pendingOrder} chase={chase} readyShip={readyShip} receive={receive} counts={counts} banner={banner} canFinanceOver={canFinanceOver} />

      {/* ── 风险中心（只读，物化投影）── */}
      <div className="mt-8">
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900">⚠️ 采购风险中心</h2>
          <span className="text-xs text-gray-400">
            {matterCounts.total > 0
              ? `高 ${matterCounts.high} · 中 ${matterCounts.medium}（每15分钟自动物化）`
              : '每15分钟自动物化'}
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
                        <Link href={`/procurement/verify/${m.order_id}`} className="text-indigo-600 hover:underline">
                          {m.order_no}
                        </Link>
                      )}
                      <span>检出 {m.detected_at?.slice(0, 10)}</span>
                    </div>
                    {/* 供应商延期风险 → 采购可直接填预计到货日处置(P2) */}
                    {m.matter_type === 'supplier_delay' && m.order_id && (m.evidence as any)?.material_name && (
                      <RiskEtaFill
                        orderId={m.order_id}
                        materialName={(m.evidence as any).material_name}
                        supplierId={(m.evidence as any).supplier_id ?? null}
                        requiredBy={(m.evidence as any).required_by ?? null}
                      />
                    )}
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
