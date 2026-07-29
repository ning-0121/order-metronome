import Link from 'next/link';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * 补录核对清单(2026-07-29 线下补录③):一页看 台账已推财务 vs 采购单应付(已下达) 按订单对照。
 * 同一订单两条钱路都有金额 → 标红「疑似双重入账」;台账未关联订单 → 标黄。只读。
 */
export default async function BackfillReconPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <div className="p-8 text-center text-gray-400">请先登录</div>;
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['admin', 'finance', 'procurement_manager', 'order_manager'].includes(r))) {
    return <div className="p-8 text-center text-red-500">仅管理/财务/采购经理/理单经理可查看</div>;
  }

  const svc = createServiceRoleClient();
  const [{ data: payables }, { data: pos }, { data: orders }] = await Promise.all([
    (svc.from('supplier_ledger_payables') as any).select('bill_no, supplier_name, amount_incl_tax, internal_order_no, order_id, order_no_raw, created_at'),
    (svc.from('purchase_orders') as any).select('po_no, status, total_amount, order_ids, offline_backfill, suppliers(name)')
      .not('status', 'in', '("cancelled","draft")'),
    (svc.from('orders') as any).select('id, internal_order_no, order_no, customer_name').limit(3000),
  ]);
  const orderById = new Map(((orders || []) as any[]).map((o) => [o.id, o]));

  type Row = { key: string; orderNo: string; customer: string; ledger: number; ledgerBills: string[]; po: number; poNos: string[]; offline: boolean };
  const byOrder = new Map<string, Row>();
  const rowOf = (oid: string | null, fallbackNo: string) => {
    const o = oid ? orderById.get(oid) : null;
    const key = oid || `raw:${fallbackNo}`;
    if (!byOrder.has(key)) byOrder.set(key, { key, orderNo: (o as any)?.internal_order_no || (o as any)?.order_no || fallbackNo, customer: (o as any)?.customer_name || '—', ledger: 0, ledgerBills: [], po: 0, poNos: [], offline: false });
    return byOrder.get(key)!;
  };
  const unlinked: any[] = [];
  for (const p of ((payables || []) as any[])) {
    if (!p.order_id) { unlinked.push(p); continue; }
    const r = rowOf(p.order_id, p.internal_order_no || p.order_no_raw || '?');
    r.ledger += Number(p.amount_incl_tax) || 0;
    r.ledgerBills.push(p.bill_no);
  }
  for (const p of ((pos || []) as any[])) {
    const amt = Number(p.total_amount) || 0;
    const ids: string[] = p.order_ids || [];
    for (const oid of ids) {
      const r = rowOf(oid, '?');
      r.po += ids.length > 0 ? amt / ids.length : amt;   // 多订单 PO 均摊展示(仅核对用,非记账口径)
      r.poNos.push(p.po_no + ((p as any).offline_backfill ? '🏷' : ''));
      if ((p as any).offline_backfill) r.offline = true;
    }
  }
  const rows = [...byOrder.values()].filter((r) => r.ledger > 0 || r.po > 0);
  const conflicts = rows.filter((r) => r.ledger > 0 && r.po > 0);
  const clean = rows.filter((r) => !(r.ledger > 0 && r.po > 0)).sort((a, b) => (b.ledger + b.po) - (a.ledger + a.po));
  const yuan = (n: number) => `¥${(Math.round(n * 100) / 100).toLocaleString()}`;

  const Table = ({ list, red }: { list: Row[]; red?: boolean }) => (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr><th className="px-3 py-2 text-left">订单</th><th className="px-3 py-2 text-left">客户</th>
            <th className="px-3 py-2 text-right">台账已推(含税)</th><th className="px-3 py-2 text-left">LG单</th>
            <th className="px-3 py-2 text-right">采购单应付</th><th className="px-3 py-2 text-left">采购单</th></tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.key} className={`border-t border-gray-100 ${red ? 'bg-red-50/60' : ''}`}>
              <td className="px-3 py-2 font-medium text-gray-900">{r.orderNo}</td>
              <td className="px-3 py-2 text-gray-600">{r.customer}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.ledger > 0 ? yuan(r.ledger) : <span className="text-gray-300">—</span>}</td>
              <td className="px-3 py-2 text-xs text-gray-500">{r.ledgerBills.join(', ') || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.po > 0 ? yuan(r.po) : <span className="text-gray-300">—</span>}</td>
              <td className="px-3 py-2 text-xs text-gray-500">{r.poNos.join(', ') || '—'}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">无</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">🧾 补录核对清单</h1>
        <p className="text-sm text-gray-500 mt-1">
          同一订单的采购钱路应<b>二选一</b>:台账推财务(LG)或采购单下达(应付)。两边都有金额 = <span className="text-red-600 font-medium">疑似双重入账</span>,请财务核对冲销。
          🏷 = 线下补录采购单。多订单采购单金额按均摊展示(仅核对用)。
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-red-700">🔴 疑似双重入账({conflicts.length})</h2>
        <Table list={conflicts} red />
      </section>

      {unlinked.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-amber-700">🟡 台账已推但未关联订单({unlinked.length})——回 <Link href="/procurement/ledger" className="underline">对账台账</Link> 关联</h2>
          <ul className="text-sm text-gray-600 space-y-1">
            {unlinked.map((p: any) => <li key={p.bill_no}>{p.bill_no} · {p.supplier_name} · {yuan(Number(p.amount_incl_tax) || 0)} · 原单号「{p.order_no_raw || '未标'}」</li>)}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">✅ 单边正常({clean.length})</h2>
        <Table list={clean} />
      </section>
    </div>
  );
}
