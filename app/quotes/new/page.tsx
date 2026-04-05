'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createInquiry } from '@/app/actions/quotes';
import { CustomerSelect } from '@/components/CustomerSelect';
import { createClient } from '@/lib/supabase/client';

export default function NewQuotePage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);

  // 表单数据
  const [formData, setFormData] = useState<Record<string, any>>({});

  async function handleStep1(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const customerName = form.get('customer_name') as string;
    const customerId = form.get('customer_id') as string;
    if (!customerName) { setError('请选择客户'); return; }
    setFormData(prev => ({ ...prev, customer_name: customerName, customer_id: customerId }));
    setError('');
    setStep(2);
  }

  async function handleStep2(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const productDescription = form.get('product_description') as string;
    if (!productDescription) { setError('请填写产品描述'); return; }
    setFormData(prev => ({
      ...prev,
      product_description: productDescription,
      quantity: form.get('quantity') as string,
      target_price: form.get('target_price') as string,
      incoterm: form.get('incoterm') as string,
      notes: form.get('notes') as string,
    }));
    setError('');
    setStep(3);
  }

  async function handleStep3(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    // 创建报价单
    const result = await createInquiry({
      customer_name: formData.customer_name,
      customer_id: formData.customer_id,
      product_description: formData.product_description,
      quantity: formData.quantity ? parseInt(formData.quantity) : undefined,
      target_price: formData.target_price || undefined,
      notes: formData.notes || undefined,
      incoterm: formData.incoterm || 'FOB',
    });

    if (result.error) { setError(result.error); setLoading(false); return; }
    setOrderId(result.orderId || null);

    // 上传文件
    const fileInputs = e.currentTarget.querySelectorAll('input[type="file"]');
    if (result.orderId) {
      const supabase = createClient();
      for (const input of fileInputs) {
        const fileInput = input as HTMLInputElement;
        const fileType = fileInput.name;
        const files = fileInput.files;
        if (!files || files.length === 0) continue;
        for (const file of Array.from(files)) {
          const ext = file.name.split('.').pop() || 'bin';
          const path = `${result.orderId}/quote/${fileType}_${Date.now()}.${ext}`;
          await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type });
          const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(path);
          const { data: { user } } = await supabase.auth.getUser();
          await (supabase.from('order_attachments') as any).insert({
            order_id: result.orderId, file_name: file.name, file_url: urlData?.publicUrl || path,
            file_type: fileType, uploaded_by: user?.id, mime_type: file.type,
          });
        }
      }
    }

    setStep(4);
    setLoading(false);
  }

  const stepLabels = ['选择客户', '产品信息', '上传资料', '完成'];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* 步骤条 */}
      <div className="flex items-center justify-between mb-8">
        {stepLabels.map((label, i) => (
          <div key={i} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${
                step > i + 1 ? 'bg-green-500 text-white' : step === i + 1 ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500'
              }`}>{step > i + 1 ? '✓' : i + 1}</div>
              <div className="mt-1 text-xs text-gray-500">{label}</div>
            </div>
            {i < 3 && <div className={`h-0.5 flex-1 mx-2 ${step > i + 1 ? 'bg-green-500' : 'bg-gray-200'}`} />}
          </div>
        ))}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">{error}</div>}

      {/* Step 1: 选择客户 */}
      {step === 1 && (
        <form onSubmit={handleStep1} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-900">选择客户</h2>
          <p className="text-sm text-gray-500">新客户将自动创建客户资料</p>
          <CustomerSelect />
          <button type="submit" className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            下一步
          </button>
        </form>
      )}

      {/* Step 2: 产品信息 */}
      {step === 2 && (
        <form onSubmit={handleStep2} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-900">产品信息</h2>
          <p className="text-sm text-gray-500">客户: <strong>{formData.customer_name}</strong></p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">产品描述 <span className="text-red-500">*</span></label>
            <textarea name="product_description" required rows={3} placeholder="款式、面料、工艺、颜色、尺码等..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">预估数量</label>
              <input type="number" name="quantity" placeholder="件" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">目标单价</label>
              <input name="target_price" placeholder="如：$8.50/件" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">贸易条款</label>
            <select name="incoterm" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="FOB">FOB</option><option value="DDP">DDP</option>
              <option value="RMB_EX_TAX">人民币不含税</option><option value="RMB_INC_TAX">人民币含税</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
            <textarea name="notes" rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => setStep(1)} className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600">上一步</button>
            <button type="submit" className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">下一步</button>
          </div>
        </form>
      )}

      {/* Step 3: 上传资料 */}
      {step === 3 && (
        <form onSubmit={handleStep3} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-900">上传报价资料</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">📋 客户询价资料</label>
            <input type="file" name="customer_inquiry" accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png" multiple
              className="w-full text-sm" />
            <p className="text-xs text-gray-400 mt-1">客户发来的询价邮件、图片、Tech Pack等</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">💰 内部报价单</label>
            <input type="file" name="internal_quote" accept=".pdf,.xlsx,.xls,.doc,.docx" multiple
              className="w-full text-sm" />
            <p className="text-xs text-gray-400 mt-1">内部成本核算、利润分析（CEO审批用，不发客户）</p>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => setStep(2)} className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600">上一步</button>
            <button type="submit" disabled={loading}
              className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {loading ? '创建中...' : '创建报价单'}
            </button>
          </div>
        </form>
      )}

      {/* Step 4: 完成 */}
      {step === 4 && (
        <div className="bg-white rounded-xl border border-green-200 p-8 text-center">
          <div className="text-4xl mb-3">✅</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">报价单已创建</h2>
          <p className="text-sm text-gray-500 mb-6">请在报价列表中点击「提交审批」，CEO审批通过后即可发给客户</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => router.push('/quotes')} className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium">
              返回报价列表
            </button>
            {orderId && (
              <button onClick={() => router.push(`/orders/${orderId}`)} className="px-6 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600">
                查看报价详情
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
