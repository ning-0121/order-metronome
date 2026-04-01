'use client';
import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { CustomerSelect } from '@/components/CustomerSelect';
import { FactorySelect } from '@/components/FactorySelect';
import { verifyPOAgainstOrder } from '@/app/actions/po-verify';
import type { POVerifyResult } from '@/app/actions/po-verify';
import { SmartInsightsPanel } from '@/components/SmartInsightsPanel';
import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import Link from 'next/link';

/** 客户端直传文件到 Supabase Storage（绕过 Vercel 4.5MB 限制） */
async function uploadFilesToStorage(
  orderId: string,
  files: { file: File; fileType: string; label: string }[]
): Promise<string[]> {
  if (files.length === 0) return [];
  const supabase = createBrowserClient();
  const warnings: string[] = [];

  for (const { file, fileType, label } of files) {
    try {
      const ext = file.name.split('.').pop() || 'bin';
      const storagePath = `${orderId}/${fileType}_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('order-docs')
        .upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        console.warn('[upload]', label, '上传失败:', uploadError.message);
        warnings.push(`${label}上传失败，可稍后在订单详情页补传`);
        continue;
      }
      // 获取 Storage 公开 URL
      const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(storagePath);
      const publicUrl = urlData?.publicUrl || storagePath;

      // 获取当前用户 ID
      const { data: { user: currentUser } } = await supabase.auth.getUser();

      // 写入 order_attachments 记录
      const { error: dbError } = await (supabase.from('order_attachments') as any).insert({
        order_id: orderId,
        file_type: fileType,
        storage_path: storagePath,
        file_name: file.name,
        file_url: publicUrl,
        file_size: file.size,
        mime_type: file.type || null,
        uploaded_by: currentUser?.id || null,
      });
      if (dbError) {
        console.warn('[upload]', label, '记录写入失败:', dbError.message);
        warnings.push(`${label}文件已上传但记录保存失败`);
      }
    } catch (e: any) {
      console.warn('[upload]', label, '异常:', e.message);
      warnings.push(`${label}处理异常，可稍后补传`);
    }
  }
  return warnings;
}

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
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const [poVerifyResult, setPoVerifyResult] = useState<POVerifyResult | null>(null);
  const [showVerifyDialog, setShowVerifyDialog] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<FormData | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; fileType: string; label: string }[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedFactory, setSelectedFactory] = useState('');
  const [isImport, setIsImport] = useState(false);
  const [importCurrentStep, setImportCurrentStep] = useState('');

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

  const FILE_FIELDS = [
    { formKey: 'customer_po_file', fileType: 'customer_po', label: '客户PO' },
    { formKey: 'production_order_file', fileType: 'production_order', label: '生产制单' },
    { formKey: 'trims_sheet_file', fileType: 'trims_sheet', label: '辅料表' },
    { formKey: 'packing_requirement_file', fileType: 'packing_requirement', label: '装箱要求' },
    { formKey: 'tech_pack_file', fileType: 'tech_pack', label: 'Tech Pack' },
  ];

  async function handleStep1Submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!preGeneratedOrderNo) {
      showError('订单号未生成，请刷新页面重试');
      return;
    }

    const rawFormData = new FormData(e.currentTarget);

    // 提取文件
    const filesToUpload: { file: File; fileType: string; label: string }[] = [];
    for (const { formKey, fileType, label } of FILE_FIELDS) {
      const file = rawFormData.get(formKey) as File | null;
      if (file && file.size > 0) {
        filesToUpload.push({ file, fileType, label });
      }
      rawFormData.delete(formKey);
    }

    // 校验：客户PO文件必传
    const poFile = filesToUpload.find(f => f.fileType === 'customer_po');
    if (!poFile) {
      showError('请上传客户 PO 文件（必传）');
      return;
    }

    // 检查是否有客户PO文件 → 自动比对
    if (poFile && (poFile.file.type === 'application/pdf' || poFile.file.type.startsWith('image/'))) {
      setVerifying(true);
      try {
        const buffer = await poFile.file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

        const quantity = rawFormData.get('total_quantity') as string;
        const incotermVal = rawFormData.get('incoterm') as string;
        const deliveryDate = incotermVal === 'FOB'
          ? rawFormData.get('etd') as string
          : rawFormData.get('warehouse_due_date') as string;

        const verifyRes = await verifyPOAgainstOrder(base64, poFile.file.type, poFile.file.name, {
          quantity: quantity ? parseInt(quantity) : null,
          delivery_date: deliveryDate,
          customer_name: rawFormData.get('customer_name') as string,
          po_number: rawFormData.get('customer_po_number') as string,
        });

        const hasIssues = verifyRes.data && (
          verifyRes.data.differences.length > 0 ||
          (verifyRes.data.risks && verifyRes.data.risks.length > 0) ||
          (verifyRes.data.special_terms && verifyRes.data.special_terms.length > 0)
        );
        if (hasIssues) {
          // 有差异 → 弹窗让用户选择
          setPoVerifyResult(verifyRes.data);
          setPendingFormData(rawFormData);
          setPendingFiles(filesToUpload);
          setShowVerifyDialog(true);
          setVerifying(false);
          return;
        }
      } catch {
        // 比对失败不阻断创建
      }
      setVerifying(false);
    }

    // 无差异或无PO文件 → 直接创建
    await doCreateOrder(rawFormData, filesToUpload);
  }

  /** 忽略差异，继续创建 */
  async function handleIgnoreAndSubmit() {
    setShowVerifyDialog(false);
    if (pendingFormData) {
      await doCreateOrder(pendingFormData, pendingFiles);
    }
  }

  /** 实际创建订单 */
  async function doCreateOrder(rawFormData: FormData, filesToUpload: { file: File; fileType: string; label: string }[]) {
    setLoading(true);
    try {
      const result = await createOrder(rawFormData, preGeneratedOrderNo!);

      if (!result.ok) {
        showError(result.error || '创建订单失败');
        return;
      }

      const newOrderId = result.orderId!;
      setOrderId(newOrderId);

      if (filesToUpload.length > 0) {
        const uploadWarns = await uploadFilesToStorage(newOrderId, filesToUpload);
        if (uploadWarns.length > 0) setUploadWarnings(uploadWarns);
      }

      const milestonesResult = await getMilestonesByOrder(newOrderId);
      if (milestonesResult.data) setMilestones(milestonesResult.data);
      router.push('/orders/new?step=2&order_id=' + newOrderId);
      setCurrentStep(2);

    } catch (err: any) {
      showError(err?.message || '创建订单时发生意外错误');
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

          {/* 历史订单导入开关 */}
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isImport}
                onChange={(e) => { setIsImport(e.target.checked); if (!e.target.checked) setImportCurrentStep(''); }}
                className="w-4 h-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
              />
              <div>
                <span className="text-sm font-semibold text-amber-800">进行中订单导入</span>
                <span className="text-xs text-amber-600 ml-2">已在执行的订单，跳过已完成节点</span>
              </div>
            </label>

            {isImport && (
              <div className="mt-4 space-y-3">
                <label className="block text-sm font-medium text-amber-800">
                  当前正在执行的阶段 <span className="text-red-500">*</span>
                </label>
                <select
                  value={importCurrentStep}
                  onChange={(e) => setImportCurrentStep(e.target.value)}
                  className="block w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                >
                  <option value="">请选择当前执行到哪个节点</option>
                  {[
                    { label: '订单评审', keys: ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'] },
                    { label: '预评估', keys: ['order_docs_bom_complete', 'bulk_materials_confirmed'] },
                    { label: '工厂匹配与产前样', keys: ['processing_fee_confirmed', 'factory_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'] },
                    { label: '采购与生产', keys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'] },
                    { label: '过程控制', keys: ['mid_qc_check', 'final_qc_check'] },
                    { label: '出货控制', keys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'] },
                    { label: '物流收款', keys: ['booking_done', 'customs_export', 'finance_shipment_approval', 'shipment_execute', 'payment_received'] },
                  ].map(group => (
                    <optgroup key={group.label} label={group.label}>
                      {group.keys.map(key => {
                        const t = MILESTONE_TEMPLATE_V1.find(m => m.step_key === key);
                        return t ? <option key={key} value={key}>{t.name}</option> : null;
                      })}
                    </optgroup>
                  ))}
                </select>

                {importCurrentStep && (() => {
                  const idx = MILESTONE_TEMPLATE_V1.findIndex(m => m.step_key === importCurrentStep);
                  const doneCount = idx;
                  const remainCount = MILESTONE_TEMPLATE_V1.length - idx - 1;
                  const currentName = MILESTONE_TEMPLATE_V1[idx]?.name;
                  return (
                    <div className="text-xs text-amber-700 bg-amber-100 rounded-md px-3 py-2">
                      <span className="font-medium">{currentName}</span> 设为进行中，
                      前 <span className="font-bold">{doneCount}</span> 个节点标记已完成，
                      后 <span className="font-bold">{remainCount}</span> 个节点从今天重新排期
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <form onSubmit={handleStep1Submit} className="space-y-8"
            onChange={(e) => {
              const form = e.currentTarget;
              const cn = (form.querySelector('input[name="customer_name"]') as HTMLInputElement)?.value || '';
              const fn = (form.querySelector('input[name="factory_name"]') as HTMLInputElement)?.value || '';
              if (cn !== selectedCustomer) setSelectedCustomer(cn);
              if (fn !== selectedFactory) setSelectedFactory(fn);
            }}
          >

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
                    <option value="trial">新品试单</option>
                    <option value="bulk">正常</option>
                    <option value="repeat">翻单</option>
                    <option value="urgent">加急订单</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    预估总数量（件）<span className="text-red-500">*</span>
                  </label>
                  <input type="number" name="total_quantity" min="1" required
                    placeholder="此 PO 总件数"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    款数 <span className="text-red-500">*</span>
                  </label>
                  <input type="number" name="style_count" min="1" required
                    placeholder="此 PO 涉及款数"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    颜色数 <span className="text-red-500">*</span>
                  </label>
                  <input type="number" name="color_count" min="1" required
                    placeholder="此 PO 共计颜色数"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
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
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    出厂日期 <span className="text-red-500">*</span>
                  </label>
                  <input type="date" name="factory_date" required
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ETD（离港日）<span className="text-red-500">*</span>
                  </label>
                  <input type="date" name="etd" required
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ETA（到港/到仓日）<span className="text-red-500">*</span>
                  </label>
                  <input type="date" name="warehouse_due_date" required
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
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

            {/* ── AI 智脑提醒 ── */}
            <SmartInsightsPanel
              customerName={selectedCustomer}
              factoryName={selectedFactory}
            />

            {/* ── 风险标记 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1 pb-2 border-b border-gray-100">
                风险标记
              </h3>
              <p className="text-xs text-gray-400 mb-3">勾选适用项，系统将自动加强对应关卡的管控</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { name: 'new_customer', label: '新客户首单', desc: '首次合作客户，需格外重视' },
                  { name: 'new_factory', label: '新工厂首单', desc: '首次合作工厂，需加强跟进' },
                  { name: 'has_plus_size', label: '大码款', desc: '含 XL 以上尺码' },
                  { name: 'high_stretch', label: '高弹面料', desc: '氨纶 / 四面弹' },
                  { name: 'light_color_risk', label: '浅色风险', desc: '白 / 米 / 浅灰容易色差' },
                  { name: 'color_clash_risk', label: '撞色风险', desc: '深浅色拼接，容易沾色' },
                  { name: 'complex_print', label: '复杂印花', desc: '满印 / 精细对位' },
                  { name: 'tight_deadline', label: '交期紧急', desc: '交期比标准周期短' },
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

            {/* ── 客户备注 ── */}
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4 pb-2 border-b border-gray-100">
                客户备注
              </h3>
              <textarea name="notes" rows={3}
                placeholder="填写客户的额外需求、特殊要求、注意事项等..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
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
              <p className="text-xs text-gray-400 mt-2">支持 PDF、Excel、Word、JPG、PNG，单文件 ≤ 20MB（文件直传云存储，不影响订单创建）</p>
            </div>

            {/* 提交按钮上方的错误提示（确保用户能看到） */}
            {error && (
              <div ref={bottomErrorRef} className="rounded-lg bg-red-50 border border-red-300 p-4 text-sm text-red-800 animate-pulse">
                <span className="font-semibold">⚠ 创建失败：</span>{error}
              </div>
            )}

            {/* 历史导入隐藏字段 */}
            {isImport && (
              <>
                <input type="hidden" name="is_import" value="true" />
                <input type="hidden" name="import_current_step" value={importCurrentStep} />
              </>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <button type="button" onClick={() => router.back()}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                取消
              </button>
              <button type="submit" disabled={loading || verifying || !preGeneratedOrderNo || orderNoLoading || (isImport && !importCurrentStep)}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">
                {verifying ? '正在比对PO...' : loading ? '创建中...' : isImport ? '导入订单 →' : '创建订单 →'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* PO 比对差异弹窗 */}
      {showVerifyDialog && poVerifyResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowVerifyDialog(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="text-2xl">🔍</span>
              <h3 className="text-lg font-bold text-gray-900">AI 订单审核报告</h3>
            </div>

            {/* 数据差异 */}
            {poVerifyResult.differences.length > 0 && (
              <>
                <p className="text-sm font-medium text-red-700">⚠️ 数据差异</p>
                <div className="border border-red-200 rounded-lg divide-y divide-red-100">
                  {poVerifyResult.differences.map((d, i) => (
                    <div key={i} className="px-4 py-3 flex items-center gap-3 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        d.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                      }`}>{d.fieldLabel}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500">PO：</span>
                          <span className="font-bold text-red-600">{d.poValue}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500">你填的：</span>
                          <span className="font-medium text-gray-700">{d.orderValue}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* 风险提醒 */}
            {poVerifyResult.risks && poVerifyResult.risks.length > 0 && (
              <>
                <p className="text-sm font-medium text-orange-700">🚨 生产风险提醒</p>
                <div className="border border-orange-200 rounded-lg divide-y divide-orange-100">
                  {poVerifyResult.risks.map((r, i) => (
                    <div key={i} className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          r.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                        }`}>{r.label}</span>
                      </div>
                      <p className="text-gray-600 text-xs">{r.detail}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* 特殊条款 */}
            {poVerifyResult.special_terms && poVerifyResult.special_terms.length > 0 && (
              <>
                <p className="text-sm font-medium text-blue-700">📋 客户特殊条款</p>
                <div className="border border-blue-200 rounded-lg bg-blue-50 p-3">
                  <ul className="space-y-1">
                    {poVerifyResult.special_terms.map((t, i) => (
                      <li key={i} className="text-xs text-blue-800 flex gap-2"><span>•</span>{t}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {/* 一致项 */}
            {poVerifyResult.matched.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {poVerifyResult.matched.map((m, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600">✓ {m}</span>
                ))}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setShowVerifyDialog(false); setPendingFormData(null); }}
                className="flex-1 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
              >
                返回修改
              </button>
              <button
                onClick={handleIgnoreAndSubmit}
                disabled={loading}
                className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                {loading ? '创建中...' : '确认无误，继续创建'}
              </button>
            </div>

            <p className="text-xs text-gray-400 text-center">AI 分析可能有误差，请结合实际情况判断</p>
          </div>
        </div>
      )}

      {/* ════ STEP 2：执行节拍 ════ */}
      {currentStep === 2 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-2">系统已生成执行节拍</h2>
          {uploadWarnings.length > 0 && (
            <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4 mb-4">
              <p className="text-sm font-medium text-yellow-800">⚠ 部分附件上传未成功：</p>
              <ul className="mt-1 text-sm text-yellow-700 list-disc list-inside">
                {uploadWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6">
            <p className="text-indigo-800 font-medium">✅ 共生成 {milestones.length} 个关键控制点</p>
            <p className="text-indigo-600 text-sm mt-1">卡风险，而不是走流程。每个控制点都是关键风险拦截点。</p>
          </div>
          {milestones.length > 0 ? (
            <div className="space-y-2 mb-6 max-h-96 overflow-y-auto">
              {milestones.map((m: any) => {
                const isDone = m.status === 'done' || m.status === '已完成';
                const isActive = m.status === 'in_progress' || m.status === '进行中';
                return (
                  <div key={m.id} className={`flex items-center justify-between p-3 rounded-lg ${
                    isDone ? 'bg-gray-100 opacity-60' : isActive ? 'bg-indigo-50 border border-indigo-200' : 'bg-gray-50'
                  }`}>
                    <div className="flex items-center gap-2">
                      {isDone && <span className="text-green-500 text-sm">✓</span>}
                      {isActive && <span className="text-indigo-500 text-sm">▶</span>}
                      <span className={`text-sm font-medium ${isDone ? 'text-gray-500 line-through' : 'text-gray-900'}`}>{m.name}</span>
                      <span className="text-xs text-gray-500">
                        截止：{m.due_at ? new Date(m.due_at).toLocaleDateString('zh-CN') : '未设置'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {isDone && <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">已完成</span>}
                      {isActive && <span className="text-xs text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded">进行中</span>}
                      {m.evidence_required && !isDone && (
                        <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded">需凭证</span>
                      )}
                    </div>
                  </div>
                );
              })}
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
