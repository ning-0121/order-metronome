import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getReceiptStatementFilters } from '@/app/actions/goods-receipt-export';
import { ReceiptStatementClient } from './ReceiptStatementClient';

// 收货对账单导出(2026-07-11):按供应商 / 物料名筛选 → 导出 Excel 发供应商对账。
export default async function ReceiptStatementPage() {
  await requireProcurementPage();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { suppliers, materials } = await getReceiptStatementFilters();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">收货对账单导出</h1>
      <p className="text-sm text-gray-500 mb-6">
        按<b>供应商</b>和/或<b>物料名</b>筛选(都可留空=全部,可单选可双选)→ 导出 Excel,
        每供应商一页,按日期列出:日期 / 物料名 / 规格 / 数量 / 收货地址 / 码单,发供应商对账。
      </p>
      <ReceiptStatementClient suppliers={suppliers} materials={materials} />
    </div>
  );
}
