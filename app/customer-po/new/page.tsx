import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CreatePOForm } from './CreatePOForm';

// 最小「创建客户 PO」入口：从已审批报价 → createPO 生成 customer_po 绑定（引用冻结快照，不重录）。
export default async function NewCustomerPOPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/quoter" className="text-sm text-gray-500 hover:text-indigo-600">← 报价</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">创建客户 PO</h1>
      <p className="text-sm text-gray-500 mb-6">
        从<b>已审批报价</b>生成 PO —— 只引用冻结快照(quote_id + 版本),不重录款/价。
      </p>
      <CreatePOForm />
    </div>
  );
}
