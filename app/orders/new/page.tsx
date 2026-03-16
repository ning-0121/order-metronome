'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
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
  // ⚠️ 系统级约束：订单号由系统预生成，页面加载时获取
  const [preGeneratedOrderNo, setPreGeneratedOrderNo] = useState<string | null>(null);
  const [orderNoLoading, setOrderNoLoading] = useState(true);

  // 从 URL query 读取 step，刷新页面不丢失
  useEffect(() => {
    const stepParam = searchParams.get('step');
    if (stepParam) {
      const step = parseInt(stepParam, 10) as Step;
      if (step >= 1 && step <= 4) {
        setCurrentStep(step);
      }
    }
    
    const orderIdParam = searchParams.get('order_id');
    if (orderIdParam) {
      setOrderId(orderIdParam);
    }
  }, [searchParams]);

  // ⚠️ 系统级约束：Step 1 页面加载时预生成订单号
  useEffect(() => {
    if (currentStep === 1 && !preGeneratedOrderNo) {
      setOrderNoLoading(true);
      preGenerateOrderNo().then((result) => {
        if (result.orderNo) {
          setPreGeneratedOrderNo(result.orderNo);
        } else {
          setError(result.error || 'Failed to generate order number');
        }
        setOrderNoLoading(false);
      });
    }
  }, [currentStep, preGeneratedOrderNo]);

  // Step 1: 创建订单
  async function handleStep1Submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // ⚠️ 系统级约束：必须使用预生成的订单号
    if (!preGeneratedOrderNo) {
      setError('订单号未生成，请刷新页面重试');
      setLoading(false);
      return;
    }

    const formData = new FormData(e.currentTarget);
    // ⚠️ 系统级约束：传入预生成的订单号
    const result = await createOrder(formData, preGeneratedOrderNo);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      const newOrderId = result.data?.id;
      setOrderId(newOrderId);
      
      // 获取生成的里程碑
      if (newOrderId) {
        const milestonesResult = await getMilestonesByOrder(newOrderId);
        if (milestonesResult.data) {
          setMilestones(milestonesResult.data);
        }
      }
      
      // 进入 Step 2
      router.push(`/orders/new?step=2&order_id=${newOrderId}`);
      setCurrentStep(2);
      setLoading(false);
    }
  }

  // Step 2: 确认里程碑
  function handleStep2Confirm() {
    router.push(`/orders/new?step=3&order_id=${orderId}`);
    setCurrentStep(3);
  }

  // Step 3: 执行说明
  function handleStep3Continue() {
    router.push(`/orders/new?step=4&order_id=${orderId}`);
    setCurrentStep(4);
  }

  // Step 4: 跳转到订单详情
  useEffect(() => {
    if (currentStep === 4 && orderId) {
      // 延迟跳转，让用户看到完成提示
      setTimeout(() => {
        router.push(`/orders/${orderId}`);
      }, 1500);
    }
  }, [currentStep, orderId, router]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* 进度指示器 */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          {[1, 2, 3, 4].map((step) => (
            <div key={step} className="flex items-center flex-1">
              <div className="flex flex-col items-center flex-1">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold ${
                    currentStep >= step
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {step}
                </div>
                <div className="mt-2 text-xs text-center text-gray-600">
                  {step === 1 && '创建订单'}
                  {step === 2 && '生成执行步骤'}
                  {step === 3 && '执行说明'}
                  {step === 4 && '进入执行'}
                </div>
              </div>
              {step < 4 && (
                <div
                  className={`h-1 flex-1 mx-2 ${
                    currentStep > step ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Step 1: 创建订单 */}
      {currentStep === 1 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-2xl font-bold mb-4">步骤 1：创建订单（基础信息）</h2>
          <p className="text-gray-600 mb-6">
            请填写订单的基础信息，系统将根据这些信息自动生成执行步骤。
          </p>

          {/* ⚠️ 系统级约束：订单号由系统预生成，页面加载时显示 */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            {orderNoLoading ? (
              <div className="flex items-center gap-2 text-blue-700">
                <span className="animate-spin">⏳</span>
                <span>系统正在生成订单号...</span>
              </div>
            ) : preGeneratedOrderNo ? (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-blue-800">订单号：</span>
                <span className="text-lg font-mono font-bold text-blue-900">
                  {preGeneratedOrderNo}
                </span>
                <span className="text-sm text-blue-600">（系统已保留）</span>
              </div>
            ) : (
              <div className="text-red-600">
                订单号生成失败，请刷新页面重试
              </div>
            )}
          </div>

          <form onSubmit={handleStep1Submit} className="space-y-6">
            {/* ⚠️ 系统级约束：订单号输入框已移除，订单号由系统预生成并显示在上方 */}
            
            <div>
              <label htmlFor="customer_name" className="block text-sm font-medium text-gray-700">
                客户名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="customer_name"
                name="customer_name"
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
                placeholder="请输入客户名称"
              />
            </div>

            <div>
              <label htmlFor="incoterm" className="block text-sm font-medium text-gray-700">
                贸易条款 <span className="text-red-500">*</span>
              </label>
              <select
                id="incoterm"
                name="incoterm"
                required
                value={incoterm}
                onChange={(e) => setIncoterm(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
              >
                <option value="">请选择贸易条款</option>
                <option value="FOB">FOB（离岸价）</option>
                <option value="DDP">DDP（完税后交货）</option>
              </select>
            </div>

            {incoterm === 'FOB' && (
              <div>
                <label htmlFor="etd" className="block text-sm font-medium text-gray-700">
                  ETD（预计离港日期） <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  id="etd"
                  name="etd"
                  required
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
                />
              </div>
            )}

            {incoterm === 'DDP' && (
              <div>
                <label htmlFor="warehouse_due_date" className="block text-sm font-medium text-gray-700">
                  仓库到货日期 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  id="warehouse_due_date"
                  name="warehouse_due_date"
                  required
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label htmlFor="order_type" className="block text-sm font-medium text-gray-700">
                订单类型 <span className="text-red-500">*</span>
              </label>
              <select
                id="order_type"
                name="order_type"
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
              >
                <option value="sample">样品订单</option>
                <option value="bulk">批量订单</option>
              </select>
            </div>

            <div>
              <label htmlFor="packaging_type" className="block text-sm font-medium text-gray-700">
                包装类型 <span className="text-red-500">*</span>
              </label>
              <select
                id="packaging_type"
                name="packaging_type"
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
              >
                <option value="standard">标准包装</option>
                <option value="custom">定制包装</option>
              </select>
            </div>

            
                {/* 选填信息 */}
                <div className="border-t border-gray-100 pt-6">
                  <p className="text-sm font-medium text-gray-500 mb-4">选填信息（可创建后补录）</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="style_no" className="block text-sm font-medium text-gray-700">款号</label>
                      <input type="text" id="style_no" name="style_no"
                        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none"
                        placeholder="如：SS2026-001" />
                    </div>
                    <div>
                      <label htmlFor="po_number" className="block text-sm font-medium text-gray-700">客户PO号</label>
                      <input type="text" id="po_number" name="po_number"
                        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none"
                        placeholder="客户采购单号" />
                    </div>
                    <div>
                      <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">数量（件）</label>
                      <input type="number" id="quantity" name="quantity" min="1"
                        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none"
                        placeholder="总件数" />
                    </div>
                    <div>
                      <label htmlFor="cancel_date" className="block text-sm font-medium text-gray-700">Cancel Date</label>
                      <input type="date" id="cancel_date" name="cancel_date"
                        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                  </div>
                </div>
<div className="flex justify-end gap-4 pt-4">
              <button
                type="button"
                onClick={() => router.back()}
                className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading || !preGeneratedOrderNo || orderNoLoading}
                className="rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? '创建中...' : '下一步'}
              </button>
            </div>
            {/* ⚠️ 系统级约束：如果用户刷新页面、中途关闭或放弃创建，预生成的订单号不回收、不删除、不重用 */}
          </form>
        </div>
      )}

      {/* Step 2: 自动生成 Gate（控制点） */}
      {currentStep === 2 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-2xl font-bold mb-4">步骤 2：系统已生成完整外贸执行节拍</h2>
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
            <p className="text-purple-800 font-semibold">
              ✅ 系统已为你生成完整外贸执行节拍（约 {milestones.length} 个关键控制点）
            </p>
            <p className="text-purple-700 text-sm mt-2">
              所有控制点已按阶段分组，并自动计算好截止日期。你只需在执行过程中更新状态即可。
            </p>
            <p className="text-purple-600 text-xs mt-2">
              💡 <strong>设计理念</strong>：卡风险，而不是走流程。每个控制点都是关键风险拦截点。
            </p>
          </div>

          {milestones.length > 0 ? (
            <div className="space-y-6 mb-6">
              {/* 按阶段分组显示 */}
              {(() => {
                const stages = ['订单启动', '原辅料', '产前样', '生产', 'QC', '出货'];
                const grouped: Record<string, any[]> = {};
                
                // 初始化分组
                stages.forEach(stage => {
                  grouped[stage] = [];
                });
                
                // 按 stage 分组（如果 milestone 有 stage 字段，否则按顺序推断）
                milestones.forEach((milestone: any) => {
                  const stage = milestone.stage || 
                    (milestone.sequence_number <= 3 ? '订单启动' :
                     milestone.sequence_number <= 6 ? '原辅料' :
                     milestone.sequence_number <= 9 ? '产前样' :
                     milestone.sequence_number <= 13 ? '生产' :
                     milestone.sequence_number <= 15 ? 'QC' : '出货');
                  if (!grouped[stage]) grouped[stage] = [];
                  grouped[stage].push(milestone);
                });
                
                return stages.map((stage) => {
                  const stageMilestones = grouped[stage] || [];
                  if (stageMilestones.length === 0) return null;
                  
                  return (
                    <div key={stage} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gradient-to-r from-blue-50 to-purple-50 px-4 py-3 border-b border-gray-200">
                        <h3 className="font-semibold text-lg text-gray-800">
                          {stage === '订单启动' && '🔐 阶段 1：订单启动'}
                          {stage === '原辅料' && '📦 阶段 2：原辅料'}
                          {stage === '产前样' && '📋 阶段 3：产前样'}
                          {stage === '生产' && '🏭 阶段 4：生产'}
                          {stage === 'QC' && '✅ 阶段 5：QC'}
                          {stage === '出货' && '🚢 阶段 6：出货'}
                        </h3>
                        <p className="text-xs text-gray-600 mt-1">
                          {stageMilestones.length} 个控制点
                        </p>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {stageMilestones.map((milestone: any, index: number) => (
                          <div
                            key={milestone.id}
                            className="p-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                          >
                            <div className="flex items-center gap-4 flex-1">
                              <div className="flex-shrink-0">
                                {milestone.required ? (
                                  <span className="inline-flex items-center px-2 py-1 rounded text-xs font-semibold bg-red-100 text-red-700">
                                    强制
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-600">
                                    建议
                                  </span>
                                )}
                              </div>
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{milestone.name}</div>
                                <div className="text-sm text-gray-600 mt-1">
                                  <span className="mr-3">负责人：{milestone.owner_role}</span>
                                  <span className="mr-3">
                                    截止：{milestone.due_at ? new Date(milestone.due_at).toLocaleDateString('zh-CN') : '未设置'}
                                  </span>
                                  {milestone.evidence_required && (
                                    <span className="text-orange-600">📎 需凭证</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className={`text-xs px-2 py-1 rounded font-medium ${
                                milestone.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                                milestone.status === 'done' ? 'bg-green-100 text-green-700' :
                                milestone.status === 'blocked' ? 'bg-red-100 text-red-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>
                                {milestone.status === 'in_progress' ? '进行中' :
                                 milestone.status === 'done' ? '已完成' :
                                 milestone.status === 'blocked' ? '卡住' : '未开始'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-600">
              正在加载执行节拍...
            </div>
          )}

          <div className="flex justify-end gap-4 pt-4">
            <button
              type="button"
              onClick={() => router.push('/orders')}
              className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
            >
              稍后查看
            </button>
            <button
              type="button"
              onClick={handleStep2Confirm}
              className="rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
            >
              确认并进入执行
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 执行说明 */}
      {currentStep === 3 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-2xl font-bold mb-4">步骤 3：执行说明</h2>
          <p className="text-gray-600 mb-6">
            了解如何管理订单执行节拍，让你快速上手。
          </p>

          <div className="space-y-6">
            <div className="border-l-4 border-blue-500 pl-4">
              <h3 className="font-semibold text-lg mb-2">控制点的 4 种状态</h3>
              <ul className="space-y-2 text-gray-700">
                <li>• <strong>未开始</strong>：控制点尚未开始执行</li>
                <li>• <strong>进行中</strong>：控制点正在执行中</li>
                <li>• <strong>卡住</strong>：遇到问题需要帮助（必须填写原因）</li>
                <li>• <strong>已完成</strong>：控制点已完成</li>
              </ul>
            </div>

            <div className="border-l-4 border-orange-500 pl-4">
              <h3 className="font-semibold text-lg mb-2">卡住 / 解卡住 / 延期</h3>
              <p className="text-gray-700 mb-2">
                <strong>卡住不是失败</strong>，是为了让系统知道你需要帮助。
              </p>
              <ul className="space-y-2 text-gray-700">
                <li>• <strong>卡住</strong>：当控制点遇到问题时，设置为"卡住"并填写原因。系统会自动通知相关负责人。</li>
                <li>• <strong>解卡住</strong>：问题解决后，将状态改回"进行中"即可继续。系统会记录解卡时间。</li>
                <li>• <strong>延期</strong>：如果预计无法按时完成，可以申请延期。系统会记录延期原因和新的截止日期。</li>
              </ul>
            </div>

            <div className="border-l-4 border-red-500 pl-4">
              <h3 className="font-semibold text-lg mb-2">依赖关系与违规推进</h3>
              <p className="text-gray-700 mb-2">
                <strong>强制控制点必须按顺序完成</strong>，系统会自动检查依赖关系。
              </p>
              <ul className="space-y-2 text-gray-700">
                <li>• 如果依赖的强制控制点未完成，无法开始后续控制点</li>
                <li>• 系统会在 Dashboard 中显示"依赖阻塞/违规推进"异常</li>
                <li>• 违规推进的控制点会被标记，需要立即处理</li>
              </ul>
            </div>

            <div className="border-l-4 border-green-500 pl-4">
              <h3 className="font-semibold text-lg mb-2">日常使用建议</h3>
              <ul className="space-y-2 text-gray-700">
                <li>• <strong>不需要每天维护全部控制点</strong>，只处理"异常"情况</li>
                <li>• 系统会在 Dashboard 中突出显示：已超期、今日到期、卡住清单、依赖阻塞</li>
                <li>• 完成一个控制点后，系统会自动检查是否可以开始下一个控制点</li>
              </ul>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600">
                💡 <strong>提示</strong>：进入订单详情页后，你可以随时更新控制点的状态。
                系统会自动记录所有变更，方便后续回顾。
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-4 pt-6">
            <button
              type="button"
              onClick={() => router.push('/orders')}
              className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
            >
              稍后查看
            </button>
            <button
              type="button"
              onClick={handleStep3Continue}
              className="rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
            >
              进入订单执行页
            </button>
          </div>
        </div>
      )}

      {/* Step 4: 跳转中 */}
      {currentStep === 4 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
          <div className="py-12">
            <div className="text-6xl mb-4">✅</div>
            <h2 className="text-2xl font-bold mb-2">向导完成！</h2>
            <p className="text-gray-600 mb-6">
              正在跳转到订单执行页面...
            </p>
            {orderId && (
              <Link
                href={`/orders/${orderId}`}
                className="text-blue-600 hover:text-blue-700 underline"
              >
                如果未自动跳转，请点击这里
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
    <Suspense fallback={<div className="mx-auto max-w-4xl p-6">加载中...</div>}>
      <NewOrderWizard />
    </Suspense>
  );
}
