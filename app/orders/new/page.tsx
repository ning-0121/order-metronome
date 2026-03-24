'use client';
import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { CustomerSelect } from '@/components/CustomerSelect';
import { FactorySelect } from '@/components/FactorySelect';
import Link from 'next/link';

type Step = 1 | 2 | 3 | 4;

function NewOrderWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<any[]>([]);
  const [incoterm, setIncoterm] = useState<string>('');
  const [shippingSampleRequired, setShippingSampleRequired] = useState(false);
  const [preGeneratedOrderNo, setPreGeneratedOrderNo] = useState<string | null>(null);
  const [orderNoLoading, setOrderNoLoading] = useState(true);

  useEffect(() => {
    const stepParam = searchParams.get('step');
    if (stepParam) {
      const step = parseInt(stepParam, 10) as Step;
      if (step >= 1 && step <= 4) setCurrentStep(step);
    }
    const orderIdParam = searchParams.get('order_id');
    if (orderIdParam) setOrderId(orderIdParam);
  }, [searchParams]);

  useEffect(() => {
    if (currentStep === 1 && !preGeneratedOrderNo) {
      setOrderNoLoading(true);
      preGenerateOrderNo().then((result) => {
        if (result.orderNo) setPreGeneratedOrderNo(result.orderNo);
        else setError(result.error || '订单号生成失败');
        setOrderNoLoading(false);
      });
    }
  }, [currentStep, preGeneratedOrderNo]);

  const errorRef = React.useRef<HTMLDivElement>(null);
  const bottomErrorRef = React.useRef<HTMLDivElement>(null);

  function showError(msg: string) {
    setError(msg);
    // 滚动到底部错误框（离按钮近），确保用户看到
    setTimeout(() => {
      bottomErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  async function handleStep1Submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    if (!preGeneratedOrderNo) {
      showError('订单号未生成，请刷新页面重试');
      setLoading(false);
      return;
    }
    try {
      const formData = new FormData(e.currentTarget);
      console.log('[前端] 调用 createOrder...');
      const result = await createOrder(formData, preGeneratedOrderNo);
      console.log('[前端] createOrder 返回:', JSON.stringify({ ok: result.ok, error: result.error, orderId: result.orderId }));

      if (!result.ok) {
        showError(result.error || '创建订单失败（服务端未返回错误详情）');
      } else {
        // 成功
        const newOrderId = result.orderId;
        setOrderId(newOrderId || null);
        if (result.warning) {
          console.warn('[前端] 订单已创建，但有附件警告:', result.warning);
        }
        if (newOrderId) {
          const milestonesResult = await getMilestonesByOrder(newOrderId);
          if (milestonesResult.data) setMilestones(milestonesResult.data);
        }
        router.push('/orders/new?step=2&order_id=' + newOrderId);
        setCurrentStep(2);
      }
    } catch (err: any) {
      console.error('[前端] createOrder 异常:', err);
      showError(err?.message || '创建订单时发生意外错误，请重试');
    } finally {
      setLoading(false);
    }
  }

  function handleStep2Confirm() {
    router.push('/orders/new?step=3&order_id=' + orderId);
    setCurrentStep(3);
  }

  function handleStep3Continue() {
    router.push('/orders/new?step=4&order_id=' + orderId);
    setCurrentStep(4);
  }

  useEffect(() => {
    if (currentStep === 4 && orderId) {
      setTimeout(() => { router.push('/orders/' + orderId); }, 1500);
    }
  }, [currentStep, orderId, router]);

  const stepLabels = ['创建订单', '执行节拍', '执行说明', '进入执行'];

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      {/* 进度条 */}
      <div className="flex items-center justify-between mb-8">
        {[1, 2, 3, 4].map((step) => (
          <div key={step} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div className={'w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ' +
                (currentStep >= step ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500')}>
                {step}
              </div>
              <div className="mt-1.5 text-xs text-center text-gray-500">{stepLabels[step - 1]}</div>
            </div>
            {step < 4 && (
              <div className={'h-0.5 flex-1 mx-2 ' + (currentStep > step ? 'bg-indigo-600' : 'bg-gray-200')} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div ref={errorRef} className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          <span className="font-medium">⚠ 创建失败：</span>{error}
        </div>
      )}

      {/* ════ STEP 1：创建订单 ════ */}
      {currentStep === 1 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-1">新建订单</h2>
          <p className="text-sm text-gray-500 mb-6">以客户 PO 为单位录入，系统将自动生成执行节拍</p>

          {/* 系统单号 */}
          <div className="mb-6 p-3 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center gap-3">
            <span className="text-sm font-medium text-indigo-700">系统单号：</span>
            {orderNoLoading ? (
              <span className="text-sm text-indigo-500">生成中...</span>
            ) : preGeneratedOrderNo ? (
              <span className="font-mono font-bold text-indigo-900">{preGeneratedOrderNo}</span>
            ) : (
              <span className="text-sm text-red-600">生成失败，请刷新</span>
            )}
          </div>

          <form onSubmit={handleStep1Submit} className="space-y-8">

            {/* ── 基本信息 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4 pb-2 border-b border-gray-100">
                基本信息
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <CustomerSelect />
                </div>
                <div>
                  <FactorySelect />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    客户 PO 号 <span className="text-red-500">*</span>
                  </label>
                  <input type="text" name="customer_po_number" required
                    placeholder="客户采购单号"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    订单日期 <span className="text-red-500">*</span>
                  </label>
                  <input type="date" name="order_date" required
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    订单类型 <span className="text-red-500">*</span>
                  </label>
                  <select name="order_type" required
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="">请选择</option>
                    <option value="sample">样品单</option>
                    <option value="bulk">大货单</option>
                    <option value="repeat">翻单</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">预估总数量（件）</label>
                  <input type="number" name="total_quantity" min="1"
                    placeholder="此 PO 总件数"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">款数</label>
                  <input type="number" name="style_count" min="1"
                    placeholder="此 PO 涉及款数"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
              </div>
            </div>

            {/* ── 贸易 & 航运 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4 pb-2 border-b border-gray-100">
                贸易 & 航运
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    贸易条款 <span className="text-red-500">*</span>
                  </label>
                  <select name="incoterm" required value={incoterm}
                    onChange={(e) => setIncoterm(e.target.value)}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="">请选择</option>
                    <option value="FOB">FOB（离岸价）</option>
                    <option value="DDP">DDP（完税后交货）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Cancel Date</label>
                  <input type="date" name="cancel_date"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                {incoterm === 'FOB' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      ETD（预计离港日）<span className="text-red-500">*</span>
                    </label>
                    <input type="date" name="etd" required
                      className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                )}
                {incoterm === 'DDP' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ETA（到仓日期）<span className="text-red-500">*</span>
                      </label>
                      <input type="date" name="eta" required
                        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        仓库截止日期 <span className="text-red-500">*</span>
                      </label>
                      <input type="date" name="warehouse_due_date" required
                        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    </div>
                  </>
                )}
                <div className="col-span-2">
                  <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50">
                    <input type="checkbox" name="shipping_sample_required" value="true"
                      checked={shippingSampleRequired}
                      onChange={(e) => setShippingSampleRequired(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600" />
                    <div>
                      <span className="text-sm font-medium text-gray-900">需要 Shipping Sample</span>
                      <p className="text-xs text-gray-500 mt-0.5">勾选后需填写截止日期</p>
                    </div>
                  </label>
                </div>
                {shippingSampleRequired && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Shipping Sample 截止日 <span className="text-red-500">*</span>
                    </label>
                    <input type="date" name="shipping_sample_deadline" required
                      className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                )}
              </div>
            </div>

            {/* ── 风险标记 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1 pb-2 border-b border-gray-100">
                风险标记
              </h3>
              <p className="text-xs text-gray-400 mb-3">勾选适用项，系统将自动加强对应关卡的管控</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { name: 'has_plus_size', label: '大码款', desc: '含 XL 以上尺码' },
                  { name: 'high_stretch', label: '高弹面料', desc: '氨纶 / 四面弹' },
                  { name: 'light_color_risk', label: '浅色风险', desc: '白 / 米 / 浅灰' },
                  { name: 'complex_print', label: '复杂印花', desc: '满印 / 精细对位' },
                  { name: 'new_customer', label: '新客户', desc: '首次合作' },
                ].map(({ name, label, desc }) => (
                  <label key={name} className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" name={name} value="true"
                      className="w-4 h-4 mt-0.5 rounded border-gray-300 text-indigo-600" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{label}</div>
                      <div className="text-xs text-gray-400">{desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* ── 文件上传 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4 pb-2 border-b border-gray-100">
                文件上传
              </h3>
              <div className="space-y-3">
                {[
                  { name: 'customer_po_file', label: '客户 PO', required: true },
                  { name: 'production_order_file', label: '生产制单', required: false, hint: '财务审核后2日内上传' },
                  { name: 'trims_sheet_file', label: '辅料表', required: false },
                  { name: 'packing_requirement_file', label: '装箱要求', required: false },
                  { name: 'tech_pack_file', label: '工艺单 Tech Pack', required: false },
                ].map(({ name, label, required, hint }) => (
                  <div key={name} className="flex items-center gap-4 p-3 rounded-lg border border-gray-200">
                    <div className="w-36 flex-shrink-0">
                      <span className="text-sm font-medium text-gray-700">{label}</span>
                      {required ? (
                        <span className="text-red-500 ml-1 text-xs">必传</span>
                      ) : (
                        <span className="text-gray-400 ml-1 text-xs">可选</span>
                      )}
                      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
                    </div>
                    <input type="file" name={name}
                      accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                      className="flex-1 text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer" />
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">支持 PDF、Excel、Word、JPG、PNG，单文件 ≤ 20MB</p>
            </div>

            {/* 提交按钮上方的错误提示（确保用户能看到） */}
            {error && (
              <div ref={bottomErrorRef} className="rounded-lg bg-red-50 border border-red-300 p-4 text-sm text-red-800 animate-pulse">
                <span className="font-semibold">⚠ 创建失败：</span>{error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <button type="button" onClick={() => router.back()}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                取消
              </button>
              <button type="submit" disabled={loading || !preGeneratedOrderNo || orderNoLoading}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">
                {loading ? '创建中...' : '创建订单 →'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ════ STEP 2：执行节拍 ════ */}
      {currentStep === 2 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-2">系统已生成执行节拍</h2>
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6">
            <p className="text-indigo-800 font-medium">✅ 共生成 {milestones.length} 个关键控制点</p>
            <p className="text-indigo-600 text-sm mt-1">卡风险，而不是走流程。每个控制点都是关键风险拦截点。</p>
          </div>
          {milestones.length > 0 ? (
            <div className="space-y-2 mb-6 max-h-96 overflow-y-auto">
              {milestones.map((m: any) => (
                <div key={m.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{m.name}</span>
                    <span className="ml-3 text-xs text-gray-500">
                      截止：{m.due_at ? new Date(m.due_at).toLocaleDateString('zh-CN') : '未设置'}
                    </span>
                  </div>
                  {m.evidence_required && (
                    <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded">需凭证</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-400 py-8">节拍加载中...</p>
          )}
          <div className="flex justify-end gap-3">
            <button onClick={() => router.push('/orders')}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              稍后查看
            </button>
            <button onClick={handleStep2Confirm}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm text-white hover:bg-indigo-700 font-medium">
              确认并继续 →
            </button>
          </div>
        </div>
      )}

      {/* ════ STEP 3：执行说明 ════ */}
      {currentStep === 3 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">执行说明</h2>
          <div className="space-y-5">
            {[
              { color: 'indigo', title: '四种节点状态', items: ['未开始：控制点尚未启动', '进行中：正在执行', '卡住：遇到问题需要上报（必须填原因）', '已完成：节点关闭'] },
              { color: 'orange', title: '卡住 / 解卡 / 延期', items: ['卡住不是失败，是主动上报风险', '问题解决后改回进行中即可继续', '无法按时完成可申请延期并记录原因'] },
              { color: 'green', title: '日常使用建议', items: ['不需要每天维护全部节点，只处理异常', 'Dashboard 会突出显示：超期、今日到期、卡住、阻塞', '完成一个节点后系统自动检查下一节点'] },
            ].map(({ color, title, items }) => (
              <div key={title} className={'border-l-4 pl-4 ' + 'border-' + color + '-400'}>
                <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                <ul className="space-y-1">
                  {items.map(item => <li key={item} className="text-sm text-gray-600">· {item}</li>)}
                </ul>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => router.push('/orders')}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              稍后查看
            </button>
            <button onClick={handleStep3Continue}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm text-white hover:bg-indigo-700 font-medium">
              进入订单执行页 →
            </button>
          </div>
        </div>
      )}

      {/* ════ STEP 4：完成 ════ */}
      {currentStep === 4 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <div className="py-12">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-bold mb-2">订单创建成功！</h2>
            <p className="text-gray-500 mb-6">正在跳转到订单执行页面...</p>
            {orderId && (
              <Link href={'/orders/' + orderId} className="text-indigo-600 hover:underline text-sm">
                如未自动跳转，请点击这里
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function NewOrderPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-3xl p-6 text-gray-400">加载中...</div>}>
      <NewOrderWizard />
    </Suspense>
  );
}
