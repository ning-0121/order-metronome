import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionCenter, type ProductionOrderRow, type ProductionStatus } from '@/app/actions/production-center';

/**
 * 生产中心(Production Center)Phase 1 —— 跨订单生产执行分析 HUB。
 * 规格 §1 执行分析(READY/PARTIAL/BLOCKED)+ §5 节拍同步(生产节点要不要动)。
 * 门禁:生产/生产经理/理单/管理员。**不显示售价/毛利/成本**(生产角色红线)。
 * 确定性:状态由物料就绪 + 生产节点纯派生,不猜。
 */

export const dynamic = 'force-dynamic';

const STATUS_META: Record<ProductionStatus, { label: string; badge: string; tone: string }> = {
  BLOCKED: { label: '缺料·卡', badge: 'bg-red-100 text-red-700 border-red-200', tone: 'border-l-red-400' },
  PARTIAL: { label: '部分在途', badge: 'bg-amber-100 text-amber-700 border-amber-200', tone: 'border-l-amber-400' },
  READY: { label: '可开产', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', tone: 'border-l-emerald-400' },
  NO_MATERIALS: { label: '未起料', badge: 'bg-gray-100 text-gray-500 border-gray-200', tone: 'border-l-gray-300' },
};

const NODE_LABEL: Record<string, string> = {
  pending: '未开始', in_progress: '进行中', done: '已完成', completed: '已完成', blocked: '受阻',
};

function nodeText(n: { status: string | null; due: string | null } | null): { text: string; cls: string } {
  if (!n) return { text: '无此节点', cls: 'text-gray-400' };
  const st = String(n.status || 'pending').toLowerCase();
  const label = NODE_LABEL[st] || st;
  const done = ['done', 'completed', '已完成'].includes(st);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !done && n.due && n.due < today;
  return {
    text: `${label}${n.due ? ` · ${n.due}` : ''}${overdue ? ' ⚠逾期' : ''}`,
    cls: done ? 'text-emerald-600' : overdue ? 'text-red-600 font-medium' : 'text-gray-600',
  };
}

function MatBar({ m }: { m: ProductionOrderRow['material'] }) {
  if (m.total === 0) return <span className="text-xs text-gray-400">未起料</span>;
  const pct = (n: number) => `${(n / m.total) * 100}%`;
  return (
    <div className="w-32">
      <div className="flex h-2 w-full overflow-hidden rounded bg-gray-100">
        <div className="bg-emerald-400" style={{ width: pct(m.received) }} />
        <div className="bg-amber-300" style={{ width: pct(m.in_transit) }} />
        <div className="bg-red-300" style={{ width: pct(m.pending) }} />
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500">
        到 {m.received}/{m.total}{m.pending > 0 ? ` · 未下单 ${m.pending}` : ''}
      </div>
    </div>
  );
}

function StatCard({ n, label, tone, href }: { n: number; label: string; tone: string; href?: string }) {
  const inner = (
    <div className={`rounded-lg border px-4 py-3 ${tone}`}>
      <div className="text-2xl font-bold tabular-nums">{n}</div>
      <div className="text-xs text-gray-600">{label}</div>
    </div>
  );
  return href ? <a href={href} className="block transition hover:opacity-80">{inner}</a> : inner;
}

export default async function ProductionCenterPage() {
  await requireProductionPage();
  const result = (await getProductionCenter()) as { data?: ProductionOrderRow[]; error?: string; summary?: any };

  if (result.error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="mb-2 text-xl font-bold text-gray-900">生产中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const rows = result.data || [];
  const s = result.summary || { total: rows.length, blocked: 0, ready: 0, partial: 0, overdue: 0 };
  const today = rows.filter((r) => r.production_status === 'BLOCKED' || r.overdue);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-gray-900">生产中心</h1>
        <span className="text-xs text-gray-400">卡风险,不走流程 · 生产视角</span>
      </div>
      <p className="mb-5 text-sm text-gray-500">
        按物料就绪与生产节点派生每张订单的可开产状态。数量/物料/工厂可见,售价与成本不在此视图。
      </p>

      {/* 概览 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard n={s.total} label="在产订单" tone="border-gray-200 bg-white" />
        <StatCard n={s.blocked} label="缺料·卡" tone="border-red-200 bg-red-50" href="#blocked" />
        <StatCard n={s.overdue} label="节点逾期" tone="border-red-200 bg-red-50" href="#blocked" />
        <StatCard n={s.partial} label="部分在途" tone="border-amber-200 bg-amber-50" />
        <StatCard n={s.ready} label="可开产" tone="border-emerald-200 bg-emerald-50" />
      </div>

      {/* 今天先处理 */}
      {today.length > 0 && (
        <div id="blocked" className="mb-6 rounded-lg border border-red-200 bg-red-50/60 p-4">
          <div className="mb-2 text-sm font-semibold text-red-800">👉 今天先处理 · {today.length}</div>
          <div className="flex flex-wrap gap-2">
            {today.map((r) => (
              <Link key={r.order_id} href={`/orders/${r.order_id}`}
                className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-100">
                {r.internal_order_no || r.order_no || '订单'} · {STATUS_META[r.production_status].label}
                {r.overdue ? ' · 逾期' : ''}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 订单表 */}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white py-12 text-center text-gray-400">暂无在产订单</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">订单 / 客户</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">数量</th>
                <th className="px-3 py-2 font-medium">物料就绪</th>
                <th className="px-3 py-2 font-medium">工厂 / 工厂期</th>
                <th className="px-3 py-2 font-medium">开裁</th>
                <th className="px-3 py-2 font-medium">工厂完成</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const meta = STATUS_META[r.production_status];
                const k = nodeText(r.kickoff);
                const c = nodeText(r.completion);
                return (
                  <tr key={r.order_id} className={`border-l-2 ${meta.tone} hover:bg-gray-50`}>
                    <td className="px-3 py-2.5">
                      <Link href={`/orders/${r.order_id}`} className="font-medium text-gray-900 hover:underline">
                        {r.internal_order_no || r.order_no || '—'}
                      </Link>
                      <div className="text-xs text-gray-500">{r.customer_name || '—'}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${meta.badge}`}>{meta.label}</span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-gray-700">{r.quantity?.toLocaleString() ?? '—'}</td>
                    <td className="px-3 py-2.5"><MatBar m={r.material} /></td>
                    <td className="px-3 py-2.5">
                      <div className="text-gray-700">{r.factory_name || <span className="text-gray-400">未指定</span>}</div>
                      <div className="text-xs text-gray-500">{r.factory_date || '—'}</div>
                    </td>
                    <td className={`px-3 py-2.5 text-xs ${k.cls}`}>{k.text}</td>
                    <td className={`px-3 py-2.5 text-xs ${c.cls}`}>{c.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        状态口径:缺料·卡=有物料未下单/未保障 · 部分在途=已下单未到齐 · 可开产=物料到齐。节点逾期指开裁/工厂完成过期且未处置(可在订单里申请改期)。
      </p>
    </div>
  );
}
