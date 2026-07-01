import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getInventoryBalance } from '@/app/actions/inventory';

// 库存余额（W0）：采购收货自动入库 → 按物料 Σ 流水。领料/退料 = W1。
export default async function InventoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: balance, error } = await getInventoryBalance();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">库存余额</h1>
      <p className="text-sm text-gray-500 mb-6">采购收货自动入库(增量) · 按物料 Σ 流水。领料/退料(W1)后余额会随消耗下降。</p>

      {error ? (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">{error}</div>
      ) : !balance || balance.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
          暂无库存流水(采购收货后自动入库)
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-2 font-medium">物料</th>
                <th className="px-4 py-2 font-medium text-right">在库</th>
                <th className="px-4 py-2 font-medium">单位</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {balance.map((b: any) => (
                <tr key={b.material_key} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-800">{b.material_name || b.material_key}</td>
                  <td className={`px-4 py-2.5 text-right font-mono font-semibold ${b.on_hand < 0 ? 'text-red-600' : 'text-gray-900'}`}>{b.on_hand}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{b.unit || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
