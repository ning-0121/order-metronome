'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createInquiry } from '@/app/actions/quotes';
import { CustomerSelect } from '@/components/CustomerSelect';

export default function NewQuotePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = new FormData(e.currentTarget);
    const result = await createInquiry({
      customer_name: form.get('customer_name') as string,
      customer_id: form.get('customer_id') as string,
      product_description: form.get('product_description') as string,
      quantity: form.get('quantity') ? parseInt(form.get('quantity') as string) : undefined,
      target_price: form.get('target_price') as string || undefined,
      notes: form.get('notes') as string || undefined,
      incoterm: form.get('incoterm') as string || 'FOB',
    });

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      router.push('/quotes');
      router.refresh();
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">新建报价单</h1>
      <p className="text-sm text-gray-500 mb-6">填写客户询价信息，提交后管理员审批</p>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <CustomerSelect />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">产品描述 <span className="text-red-500">*</span></label>
          <textarea name="product_description" required rows={3} placeholder="款式、面料、工艺等产品描述..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">预估数量</label>
            <input type="number" name="quantity" placeholder="件" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">目标单价</label>
            <input type="text" name="target_price" placeholder="如：$8.50/件" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">贸易条款</label>
          <select name="incoterm" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="FOB">FOB</option>
            <option value="DDP">DDP</option>
            <option value="RMB_EX_TAX">人民币不含税</option>
            <option value="RMB_INC_TAX">人民币含税</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
          <textarea name="notes" rows={2} placeholder="其他说明..." className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={loading}
            className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {loading ? '提交中...' : '提交报价单'}
          </button>
          <button type="button" onClick={() => router.back()}
            className="px-6 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600">取消</button>
        </div>
      </form>
    </div>
  );
}
