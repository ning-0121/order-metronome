import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupplierLedger } from '@/app/actions/supplier-ledger';
import { SupplierLedgerClient } from './SupplierLedgerClient';

// 供应商采购对账台账(面料账目导入,2026-07-11)。
// 导入《面料采购明细表汇总》(每 sheet=一供应商)→ 按供应商×订单归集不含税应付,预埋财务对接锚点。
export default async function SupplierLedgerPage() {
  await requireProcurementPage();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { groups, grandTotalExTax, grandTotalInclTax } = await getSupplierLedger();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">供应商采购对账台账</h1>
      <p className="text-sm text-gray-500 mb-6">
        导入《面料采购明细表汇总》(每个 sheet = 一家供应商)→ 按<b>供应商 × 订单</b>归集应付(<b className="text-indigo-700">不含税</b>)。
        每行带<b>内部订单号</b>锚点,将来申请付款 / 推财务可直接对接。
      </p>
      <SupplierLedgerClient initialGroups={groups} initialGrandTotalExTax={grandTotalExTax} initialGrandTotalInclTax={grandTotalInclTax} />
    </div>
  );
}
