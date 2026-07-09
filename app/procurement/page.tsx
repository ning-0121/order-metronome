import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getProcurementQueues, getProcurementMatters, type RiskMatter } from '@/app/actions/procurement';
import { ProcurementQueueClient } from '@/components/ProcurementQueueClient';
import { RiskEtaFill } from './RiskEtaFill';

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
  const REASON_CN: Record<string, string> = {
    large_amount: '大额(≥5万)', price_variance: '价格偏差>5%', new_supplier: '新供应商',
    over_budget: '超预算', over_budget_total: '整单超预算', over_budget_material: '单料超预算(疑重复下单)',
    non_standard_terms: '非标账期',
  };
  const matters = mattersResult.data?.matters ?? [];
  const matterCounts = mattersResult.data?.counts ?? { total: 0, high: 0, medium: 0 };

  // 卡片可点开:锚到下方对应队列区块(2026-07-05 用户拍板)
  const Stat = ({ label, value, tone, href }: { label: string; value: number; tone: string; href?: string }) => {
    const inner = (<>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </>);
    return href
      ? <a href={href} className={`block rounded-xl border px-4 py-3 transition hover:shadow-md hover:-translate-y-0.5 ${tone}`}>{inner}</a>
      : <div className={`rounded-xl border px-4 py-3 ${tone}`}>{inner}</div>;
  };

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
          <Link href="/material-master" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            🧱 物料库
          </Link>
          <Link href="/procurement/cost" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            💰 成本核算
          </Link>
          <Link href="/procurement/inventory" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50">
            📦 库存
          </Link>
          <Link href="/procurement/po/new" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-500 border border-gray-200 text-sm hover:bg-gray-50" title="不走归并,手动勾行建单">
            手动建单
          </Link>
          <Link href="/procurement/netting" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            🧩 待采购工作台
          </Link>
        </div>
      </div>

      {/* Dashboard 壳：计数 */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-6">
        <Stat label="📨 待采购订单" value={counts.pendingRequests} href="#q-pendingRequests" tone="border-emerald-300 bg-emerald-50 text-emerald-800" />
        <Stat label="待下单" value={counts.pendingOrder} href="#q-pendingOrder" tone="border-indigo-200 bg-indigo-50 text-indigo-800" />
        <Stat label="待催货 / 生产中" value={counts.chase} href="#q-chase" tone="border-amber-200 bg-amber-50 text-amber-800" />
        <Stat label="已完成待送货" value={counts.readyShip} href="#q-readyShip" tone="border-sky-200 bg-sky-50 text-sky-800" />
        <Stat label="已送达待验收" value={counts.receive} href="#q-receive" tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
        <Stat label="🔴 到货逾期" value={counts.overdueOrders} href="#q-chase" tone="border-red-200 bg-red-50 text-red-800" />
        <Stat label="⚠️ 需抓紧追" value={counts.atRiskOrders} href="#q-chase" tone="border-rose-200 bg-rose-50 text-rose-800" />
      </div>

      {/* ⏳ 待审批采购单:已建、撞风险闸卡在待审批(下单没走完的真相在这)。不批准=永远挂着"待下单/待采购"。 */}
      {pendingApprovalPOs.length > 0 && (
        <div className="mb-6 rounded-xl border-2 border-orange-300 bg-orange-50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-bold text-orange-800">🧾 草稿采购单（{pendingApprovalPOs.length}）待下单/待审批</span>
            <span className="text-xs text-orange-600">这些单已建但还没真正下单;待审批的需先审批,可下单的进 PO 页传凭证后下单。不处理,订单会一直显示"待采购"。</span>
          </div>
          <div className="space-y-2">
            {pendingApprovalPOs.map((p) => {
              const isPending = p.approval_status === 'pending';
              const tbd = !isPending && p.price_tbd === true;   // 价格待定:允许无价下单
              // ¥0/未填价且非"价格待定"的单不是"可下单",而是"待填价"(2026-07-09 用户:没填价格不该到下单这步)
              const noPrice = !isPending && !tbd && (p.total_amount == null || Number(p.total_amount) <= 0);
              return (
              <div key={p.id} className="flex items-center gap-3 flex-wrap bg-white rounded-lg border border-orange-200 px-3 py-2">
                <Link href={`/procurement/po/${p.id}`} className="text-sm font-semibold text-indigo-600 hover:underline">{p.po_no}</Link>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${isPending ? 'bg-amber-100 text-amber-700' : noPrice ? 'bg-rose-100 text-rose-700' : tbd ? 'bg-purple-100 text-purple-700' : 'bg-sky-100 text-sky-700'}`}>
                  {isPending ? '待审批' : noPrice ? '待填价' : tbd ? '价格待定·可下单' : '可下单(未下单)'}
                </span>
                <span className="text-xs text-gray-500">{p.supplier_name || '—'}</span>
                {p.total_amount != null && <span className="text-xs text-gray-700">¥{p.total_amount}</span>}
                <span className="text-xs text-gray-400">
                  {(p.orders || []).map(o => o.internal_order_no || o.order_no).filter(Boolean).join(' / ')}
                </span>
                {isPending && (
                  <>
                    <div className="flex items-center gap-1 flex-wrap">
                      {(p.reasons || []).map(r => (
                        <span key={r} className="text-[11px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">{REASON_CN[r] || r}</span>
                      ))}
                    </div>
                    <span className="text-[11px] text-gray-500">
                      需{(p.required_by || []).map(s => s === 'finance' ? '财务' : '采购经理').join('+')}审批
                    </span>
                  </>
                )}
                <Link href={`/procurement/po/${p.id}`} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-orange-600 text-white font-medium hover:bg-orange-700">
                  {isPending ? '去审批 →' : noPrice ? '去填价 →' : '去下单 →'}{/* tbd 也走去下单 */}
                </Link>
              </div>
            );})}
          </div>
        </div>
      )}

      <ProcurementQueueClient pendingRequests={pendingRequests} pendingOrder={pendingOrder} chase={chase} readyShip={readyShip} receive={receive} canFinanceOver={canFinanceOver} />

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
