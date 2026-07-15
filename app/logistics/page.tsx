import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getLogisticsShipQueue } from '@/app/actions/logistics';

/**
 * 物流工作台 —— 已放货、待出运/待送仓的订单一屏看清(2026-07-13)。
 * 物流部(秦增超)收到财务放货后,在此看要发哪些货、出运方式、交期,进单安排送仓/装柜/内陆送货。
 */
export default async function LogisticsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { isAdmin, roles } = await getCurrentUserRole(supabase);
  if (!(isAdmin || roles.includes('logistics') || roles.includes('production_manager'))) {
    redirect('/dashboard');
  }

  const { data: items, error } = await getLogisticsShipQueue();
  const list = items || [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🚚 物流工作台</h1>
        <p className="mt-1 text-sm text-gray-500">财务已放货、待出运/待送仓的订单。按交期排序——安排装柜 / 报关 / 内陆送货 / 送仓。</p>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-gray-200 py-16 text-center text-sm text-gray-400">
          暂无待发货订单。财务放货后会出现在这里。
        </div>
      ) : (
        <>
          <div className="mb-3 text-sm text-gray-500">待发货 <b className="text-sky-700">{list.length}</b> 单</div>
          <div className="space-y-3">
            {list.map((it) => {
              const overdue = it.daysToDeadline != null && it.daysToDeadline < 0;
              const urgent = it.daysToDeadline != null && it.daysToDeadline >= 0 && it.daysToDeadline <= 3;
              return (
                <div key={it.orderId} className={`rounded-xl border p-4 ${overdue ? 'border-red-300 bg-red-50/40' : urgent ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200 bg-white'}`}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-semibold text-gray-900">{it.internalNo || it.orderNo}</span>
                        {it.internalNo && <span className="text-xs text-gray-400">/{it.orderNo}</span>}
                        {it.customer && <span className="text-sm text-gray-600">{it.customer}</span>}
                        <span className={`text-xs px-2 py-0.5 rounded-full ${it.isDomestic ? 'bg-teal-100 text-teal-700' : 'bg-sky-100 text-sky-700'}`}>{it.wayLabel}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 text-xs flex-wrap">
                        <span className={overdue ? 'text-red-600 font-medium' : urgent ? 'text-amber-700 font-medium' : 'text-gray-500'}>
                          交期 {it.deadline ? String(it.deadline).slice(0, 10) : '—'}
                          {it.daysToDeadline != null && (overdue ? ` · 已超 ${-it.daysToDeadline} 天` : ` · 剩 ${it.daysToDeadline} 天`)}
                        </span>
                        <span className="text-gray-400">·</span>
                        <span className="text-gray-600">当前:{it.shipNodeName}</span>
                        {!it.isDomestic && (
                          <span className={it.bookingDone ? 'text-emerald-600' : 'text-gray-400'}>{it.bookingDone ? '✓ 已订舱' : '未订舱'}</span>
                        )}
                        <span className={it.docsReady ? 'text-emerald-600' : 'text-gray-400'}>{it.docsReady ? '✓ 单据已出' : '单据未出'}</span>
                      </div>
                    </div>
                    <Link href={`/orders/${it.orderId}?tab=shipment&from=${encodeURIComponent('/logistics')}`}
                      className="shrink-0 bg-sky-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-sky-700">
                      去安排出运 →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
