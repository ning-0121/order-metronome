'use client';
import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { CustomerSelect } from '@/components/CustomerSelect';
import { FactorySelect } from '@/components/FactorySelect';
import { MultiFactorySelect } from '@/components/MultiFactorySelect';
import { verifyPOAgainstOrder, verifyThreeDocuments } from '@/app/actions/po-verify';
import type { POVerifyResult, ThreeDocVerifyResult } from '@/app/actions/po-verify';
import { SmartInsightsPanel } from '@/components/SmartInsightsPanel';
import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import Link from 'next/link';
import { isDoneStatus, isActiveStatus } from '@/lib/domain/types';

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
  const [deliveryType, setDeliveryType] = useState<string>('');
  const [shippingSampleRequired, setShippingSampleRequired] = useState(false);
  const [preGeneratedOrderNo, setPreGeneratedOrderNo] = useState<string | null>(null);
  const [orderNoLoading, setOrderNoLoading] = useState(true);
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const [poVerifyResult, setPoVerifyResult] = useState<POVerifyResult | null>(null);
  const [showVerifyDialog, setShowVerifyDialog] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<FormData | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; fileType: string; label: string }[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [threeDocResult, setThreeDocResult] = useState<ThreeDocVerifyResult | null>(null);
  const [showThreeDocDialog, setShowThreeDocDialog] = useState(false);
  // CEO 价格审批闸门（Phase 1）
  const [showPriceGate, setShowPriceGate] = useState(false);
  const [priceApprovalId, setPriceApprovalId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedFactory, setSelectedFactory] = useState('');
  const [isImport, setIsImport] = useState(false);
  const [importCurrentStep, setImportCurrentStep] = useState('');
  // 交期已过检测
  const [showPastDateDialog, setShowPastDateDialog] = useState(false);
  const [pastDateChoice, setPastDateChoice] = useState<'shipped' | 'pending' | 'problem' | ''>('');
  // PO AI 自动填表
  const [poParsing, setPoParsing] = useState(false);
  const [poParseResult, setPoParseResult] = useState<any>(null);
  const [poAutoFilled, setPoAutoFilled] = useState(false);
  const isSampleOrder = searchParams.get('type') === 'sample';
  const [orderType, setOrderType] = useState('');

  // PO 上传后自动 AI 解析并填表
  async function handlePOFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || file.size === 0) return;
    setPoParsing(true);
    setPoParseResult(null);
    setPoAutoFilled(false);
    try {
      const { parsePO } = await import('@/app/actions/po-parser');
      const fd = new FormData();
      fd.append('file', file);
      const res = await parsePO(fd);
      if (res.ok && res.data) {
        setPoParseResult(res.data);
        // 自动填写表单字段
        const form = e.target.closest('form');
        if (form) {
          const fill = (name: string, value: string | number) => {
            const el = form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
            if (el && value) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
              )?.set;
              nativeInputValueSetter?.call(el, String(value));
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          };
          const d = res.data;
          if (d.customer_name) fill('customer_name', d.customer_name);
          if (d.order_no) fill('customer_po_number', d.order_no);
          if (d.order_date) fill('order_date', d.order_date.replace(/\./g, '-'));
          // 算总数量
          const totalQty = d.styles.reduce((sum: number, s: any) => sum + (s.total_qty || 0), 0);
          if (totalQty > 0) fill('total_quantity', totalQty);
          // 款数 = styles 数组长度
          if (d.styles.length > 0) fill('style_count', d.styles.length);
          // 颜色数 = 所有款的颜色去重
          const allColors = d.styles.flatMap((s: any) => (s.colors || []).map((c: any) => c.color_en || c.color_cn));
          const uniqueColors = new Set(allColors.filter(Boolean));
          if (uniqueColors.size > 0) fill('color_count', uniqueColors.size);
          // 交期
          if (d.delivery_date) {
            const deliveryDateFormatted = d.delivery_date.replace(/\./g, '-');
            fill('etd', deliveryDateFormatted);
            fill('warehouse_due_date', deliveryDateFormatted);
            fill('factory_date', deliveryDateFormatted);
          }
          setPoAutoFilled(true);
        }
      }
    } catch (err: any) {
      console.error('[PO auto-parse]', err?.message);
    } finally {
      setPoParsing(false);
    }
  }

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
    { formKey: 'internal_quote_file', fileType: 'internal_quote', label: '内部成本核算单' },
    { formKey: 'customer_quote_file', fileType: 'customer_quote', label: '客户最终报价单' },
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

    // ── 交期已过检测：如果出厂日/交期已过，让业务确认订单状态 ──
    const incotermCheck = rawFormData.get('incoterm') as string;
    const etdCheck = rawFormData.get('etd') as string;
    const factoryDateCheck = rawFormData.get('factory_date') as string;
    const whDueDateCheck = rawFormData.get('warehouse_due_date') as string;
    const deliveryDateCheck = etdCheck || factoryDateCheck || whDueDateCheck;
    if (deliveryDateCheck && !rawFormData.get('past_date_confirmed')) {
      const deliveryTime = new Date(deliveryDateCheck + 'T23:59:59').getTime();
      const now = Date.now();
      if (deliveryTime < now) {
        // 交期已过 — 弹窗确认
        const choice = prompt(
          `⚠ 交期 ${deliveryDateCheck} 已过！请选择订单状态：\n\n` +
          `1 — 已发货（补录历史数据）\n` +
          `2 — 未发货，在途中\n` +
          `3 — 未发货，有问题\n\n` +
          `请输入 1、2 或 3：`
        );
        if (!choice || !['1', '2', '3'].includes(choice.trim())) {
          showError('请选择订单状态（1/2/3）后再创建');
          return;
        }
        const choiceMap: Record<string, string> = { '1': 'shipped', '2': 'pending', '3': 'problem' };
        rawFormData.set('past_date_status', choiceMap[choice.trim()]);
        rawFormData.set('past_date_confirmed', 'true');
        if (choice.trim() === '3') {
          const reason = prompt('请填写未发货原因（如：客户暂停、面料问题、品质返工等）：');
          if (!reason?.trim()) {
            showError('请填写未发货原因');
            return;
          }
          rawFormData.set('past_date_reason', reason.trim());
        }
      }
    }

    // 提取文件
    const filesToUpload: { file: File; fileType: string; label: string }[] = [];
    for (const { formKey, fileType, label } of FILE_FIELDS) {
      // 支持多文件（如PO可能有多个）
      const files = rawFormData.getAll(formKey) as File[];
      for (const file of files) {
        if (file && file.size > 0) {
          filesToUpload.push({ file, fileType, label });
        }
      }
      rawFormData.delete(formKey);
    }

    // 校验：3个必传文件
    const poFile = filesToUpload.find(f => f.fileType === 'customer_po');
    if (!poFile) { showError('请上传客户 PO 文件（必传）'); return; }
    if (!filesToUpload.find(f => f.fileType === 'internal_quote')) { showError('请上传内部成本核算单（必传）'); return; }
    if (!filesToUpload.find(f => f.fileType === 'customer_quote')) { showError('请上传客户最终报价单（必传）'); return; }

    // 文件验证可用格式
    const isVerifiable = (f: File) =>
      f.type === 'application/pdf' ||
      f.type.startsWith('image/') ||
      /\.(xlsx|xls|xlsm)$/i.test(f.name);

    // ═══════════════════════════════════════════════════════
    // Phase 1: 三单比对 — 价格优先（CEO 强制规则）
    // 内部报价 vs 客户报价 vs 客户PO 价格必须一致
    // ═══════════════════════════════════════════════════════
    const threeFiles = filesToUpload.filter(f =>
      ['customer_po', 'internal_quote', 'customer_quote'].includes(f.fileType)
    );
    if (threeFiles.length >= 2) {
      setVerifying(true);
      try {
        const docsForVerify = await Promise.all(threeFiles.map(async f => {
          const buf = await f.file.arrayBuffer();
          return {
            type: f.fileType as 'internal_quote' | 'customer_quote' | 'customer_po',
            base64: btoa(String.fromCharCode(...new Uint8Array(buf))),
            fileType: f.file.type,
            fileName: f.file.name,
          };
        }));
        const threeRes = await verifyThreeDocuments(docsForVerify);
        if (threeRes.data) {
          // ⚠️ 价格不一致 → 强制 CEO 审批闸门（除非已经持有有效审批）
          if (!threeRes.data.priceMatch && threeRes.data.priceDiffs.length > 0) {
            const existingApproval = priceApprovalId; // 已经批准的会被保留
            if (!existingApproval) {
              setThreeDocResult(threeRes.data);
              setPendingFormData(rawFormData);
              setPendingFiles(filesToUpload);
              setShowPriceGate(true);
              setVerifying(false);
              return;
            }
          }
          // 非价格的其他差异 → 普通弹窗（可忽略继续）
          if (!threeRes.data.allMatch && threeRes.data.differences.length > 0) {
            setThreeDocResult(threeRes.data);
            setPendingFormData(rawFormData);
            setPendingFiles(filesToUpload);
            setShowThreeDocDialog(true);
            setVerifying(false);
            return;
          }
        }
      } catch {
        // 三单比对失败不阻断创建
      }
      setVerifying(false);
    }

    // ═══════════════════════════════════════════════════════
    // Phase 2: PO 内容自检 — 数量 / 交期 / 客户名 / 文件类型
    // ═══════════════════════════════════════════════════════
    if (poFile && isVerifiable(poFile.file)) {
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

    // 全部通过 → 直接创建
    await doCreateOrder(rawFormData, filesToUpload);
  }

  /** 推送 CEO 审批价格差异 */
  async function handleRequestPriceApproval() {
    if (!threeDocResult || !pendingFormData) return;
    setLoading(true);
    try {
      const { requestPriceApproval } = await import('@/app/actions/price-approvals');
      const snapshot: Record<string, any> = {};
      pendingFormData.forEach((v, k) => {
        if (typeof v === 'string') snapshot[k] = v;
      });
      const res = await requestPriceApproval({
        customer_name: snapshot.customer_name || '',
        po_number: snapshot.customer_po_number || '',
        form_snapshot: snapshot,
        price_diffs: threeDocResult.priceDiffs,
        summary: threeDocResult.summary,
      });
      if (res.error) { alert(res.error); return; }
      setPriceApprovalId(res.id || null);
      setShowPriceGate(false);
      alert(
        '已推送 CEO 审批 ✓\n\n' +
        '请等待 CEO 在「价格审批」页面批准后，重新点击「创建订单」。\n' +
        '24 小时内审批未通过，需要重新申请。'
      );
    } catch (err: any) {
      alert('推送失败：' + err.message);
    } finally {
      setLoading(false);
    }
  }

  /** 检查 CEO 是否已批准 — 业务员点击"我已获批，重试"时调用 */
  async function handleCheckApprovalAndRetry() {
    if (!priceApprovalId || !pendingFormData) return;
    setLoading(true);
    try {
      const { getMyPriceApproval } = await import('@/app/actions/price-approvals');
      const res = await getMyPriceApproval(priceApprovalId);
      if (res.error || !res.data) { alert(res.error || '查询失败'); return; }
      const status = (res.data as any).status;
      if (status === 'pending') {
        alert('CEO 还未审批，请稍等。');
        return;
      }
      if (status === 'rejected') {
        alert('CEO 已驳回：\n' + ((res.data as any).review_note || '无备注') + '\n\n请联系客户修改 PO 后重新申请。');
        return;
      }
      if (status === 'approved') {
        setShowPriceGate(false);
        // 重新提交（priceApprovalId 仍在 state 里，下次比对会跳过价格闸门）
        await doCreateOrder(pendingFormData, pendingFiles);
      }
    } finally {
      setLoading(false);
    }
  }

  /** 忽略差异，继续创建 */
  async function handleIgnoreAndSubmit() {
    setShowVerifyDialog(false);
    setShowThreeDocDialog(false);
    if (pendingFormData) {
      await doCreateOrder(pendingFormData, pendingFiles);
    }
  }

  /** 实际创建订单 */
  async function doCreateOrder(rawFormData: FormData, filesToUpload: { file: File; fileType: string; label: string }[]) {
    setLoading(true);
    // 样品单标记
    if (isSampleOrder) {
      rawFormData.set('order_purpose', 'sample');
    }
    // 已批准的价格审批 ID 透传到服务端校验
    if (priceApprovalId) {
      rawFormData.set('price_approval_id', priceApprovalId);
    }
    try {
      const result = await createOrder(rawFormData, preGeneratedOrderNo!);

      if (!result.ok) {
        // 重复订单检测：弹窗确认后重新提交
        if ((result as any).warning === 'duplicate') {
          const confirmDup = confirm(result.error + '\n\n点击"确定"强制创建，点击"取消"返回修改。');
          if (confirmDup) {
            rawFormData.set('confirm_duplicate', 'true');
            setLoading(false);
            await doCreateOrder(rawFormData, filesToUpload);
            return;
          }
          setLoading(false);
          return;
        }
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
    if (orderId) {
      // 直接跳转到订单详情页，不再经过 step 4 中转
      router.push('/orders/' + orderId);
    } else {
      // 兜底：如果 orderId 丢失，回到订单列表
      router.push('/orders');
    }
  }

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
          <h2 className="text-xl font-bold text-gray-900 mb-1">{isSampleOrder ? '新建样品单' : '新建订单'}</h2>
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
                <div className="col-span-2">
                  <MultiFactorySelect />
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
                    客户邮箱
                  </label>
                  <input type="email" name="customer_email"
                    placeholder="客户联系邮箱（非邮箱沟通可留空）"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <p className="text-xs text-gray-400 mt-0.5">用于邮件智能匹配。微信沟通的客户可留空</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    内部订单号（订单册编号）<span className="text-red-500">*</span>
                  </label>
                  <input type="text" name="internal_order_no" required
                    placeholder="订单册编号（必填）"
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
                  <select name="order_type" required value={orderType}
                    onChange={e => setOrderType(e.target.value)}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="">请选择</option>
                    <option value="trial">新品试单</option>
                    <option value="bulk">正常</option>
                    <option value="repeat">翻单</option>
                    <option value="urgent">加急订单</option>
                  </select>
                </div>
                {/* 翻单回顾 — 仅当订单类型为"翻单"时显示 */}
                {orderType === 'repeat' && (
                  <div className="col-span-2 rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-3">
                    <h4 className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
                      📋 翻单回顾（上一单总结）
                    </h4>
                    <p className="text-xs text-amber-700">请回顾上一单的执行情况，帮助本次订单避坑。此信息将纳入客户画像。</p>
                    <div>
                      <label className="text-xs text-gray-600">上一单订单号</label>
                      <input type="text" name="repeat_prev_order_no" placeholder="如 QM-20260403-001"
                        className="mt-1 block w-full rounded-lg border border-amber-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600">上一单存在的问题 <span className="text-red-500">*</span></label>
                      <textarea name="repeat_issues" required rows={2} placeholder="如：面料缩水率偏高、交期延了5天、客户对颜色不满意..."
                        className="mt-1 block w-full rounded-lg border border-amber-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600">本次需要特别注意的事项</label>
                      <textarea name="repeat_attention" rows={2} placeholder="如：换工厂了注意品质、面料要提前测缩水、客户要求更严格的AQL..."
                        className="mt-1 block w-full rounded-lg border border-amber-300 px-3 py-2 text-sm bg-white" />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    预估总数量 <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input type="number" name="total_quantity" min="1" required
                      placeholder="数量"
                      className="block flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    <select name="quantity_unit" required
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
                      <option value="件">件</option>
                      <option value="套">套（2件）</option>
                    </select>
                  </div>
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
                    onChange={(e) => {
                      const v = e.target.value;
                      setIncoterm(v);
                      // 只有 DDP 需要我们订舱报关出运
                      // FOB / 人民币(含税/不含税) → 全部走送仓流程
                      if (v === 'DDP') setDeliveryType('export');
                      else if (v) setDeliveryType('domestic');
                      else setDeliveryType('');
                    }}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="">请选择</option>
                    <option value="RMB_EX_TAX">人民币不含税</option>
                    <option value="RMB_INC_TAX">人民币含税</option>
                    <option value="FOB">FOB（离岸价）</option>
                    <option value="DDP">DDP（完税后交货）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    交付方式
                  </label>
                  <input type="hidden" name="delivery_type" value={deliveryType} />
                  <select value={deliveryType}
                    onChange={(e) => setDeliveryType(e.target.value)}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="export">出口（DDP，含订舱/报关/出运）</option>
                    <option value="domestic">送仓（FOB / 人民币 / 国内送仓）</option>
                  </select>
                  {deliveryType === 'domestic' && (
                    <p className="text-xs text-amber-600 mt-1">将跳过订舱/报关/出运节点，替换为「国内送仓完成」</p>
                  )}
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
                {/* DDP 才需要 ETD 和 ETA */}
                {incoterm === 'DDP' && (
                  <>
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

                {/* 样品阶段选择 */}
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    样品阶段 <span className="text-red-500">*</span>
                  </label>
                  <select name="sample_phase" defaultValue="confirmed"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    <option value="confirmed">头样已确认 — 直接安排产前样</option>
                    <option value="dev_sample">需要做头样 — 头样确认后再做产前样</option>
                    <option value="dev_sample_with_revision">需要做头样 + 可能需要二次样</option>
                    <option value="skip_all">不需要产前样 — 翻单/老款/客户用设计样直接做大货</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    {`选"需要做头样"会增加头样制作→寄出→确认节点；选"可能需要二次样"会额外增加二次样节点`}
                  </p>
                </div>

                {/* 样品确认天数覆盖：针对慢确认客户 */}
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    样品确认预留天数（可选）
                  </label>
                  <input type="number" name="sample_confirm_days_override" min="7" max="60"
                    placeholder="默认 19 天 — 慢确认客户填 25-30 天"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <p className="text-xs text-gray-500 mt-1">
                    某些客户产前样确认要将近 1 个月 — 提前设置可让排期更真实
                  </p>
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
                  { name: 'customer_po_file', label: '客户 PO（可多个）', required: true, multiple: true, onPOChange: handlePOFileChange },
                  { name: 'internal_quote_file', label: '内部成本核算单', required: true },
                  { name: 'customer_quote_file', label: '客户最终报价单', required: true },
                  { name: 'production_order_file', label: '生产制单', required: false, hint: '财务审核后2日内上传' },
                  { name: 'trims_sheet_file', label: '辅料表', required: false },
                  { name: 'packing_requirement_file', label: '装箱要求', required: false },
                  { name: 'tech_pack_file', label: '工艺单 Tech Pack', required: false },
                ].map(({ name, label, required, hint, multiple, onPOChange }: any) => (
                  <div key={name} className="flex items-center gap-4 p-3 rounded-lg border border-gray-200">
                    <div className="w-44 flex-shrink-0">
                      <span className="text-sm font-medium text-gray-700">{label}</span>
                      {required ? (
                        <span className="text-red-500 ml-1 text-xs">必传</span>
                      ) : (
                        <span className="text-gray-400 ml-1 text-xs">可选</span>
                      )}
                      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
                      {name === 'customer_po_file' && poParsing && (
                        <p className="text-xs text-indigo-600 mt-0.5 animate-pulse">AI 识别中...</p>
                      )}
                    </div>
                    <input type="file" name={name}
                      multiple={!!multiple}
                      accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                      onChange={onPOChange || undefined}
                      className="flex-1 text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer" />
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">支持 PDF、Excel、Word、JPG、PNG，单文件 ≤ 20MB（文件直传云存储，不影响订单创建）</p>

              {/* PO AI 识别结果预览 */}
              {poAutoFilled && poParseResult && (
                <div className="mt-3 rounded-lg bg-green-50 border border-green-200 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-green-600 text-sm font-semibold">AI 已从 PO 自动填入表单</span>
                    {poParseResult.confidence_notes?.length > 0 && (
                      <span className="text-xs text-amber-600">（{poParseResult.confidence_notes.length} 项需确认）</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div><span className="text-gray-500">客户：</span><span className="font-medium">{poParseResult.customer_name || '—'}</span></div>
                    <div><span className="text-gray-500">PO号：</span><span className="font-medium">{poParseResult.order_no || '—'}</span></div>
                    <div><span className="text-gray-500">款数：</span><span className="font-medium">{poParseResult.styles?.length || 0}</span></div>
                    <div>
                      <span className="text-gray-500">总数：</span>
                      <span className="font-medium">{poParseResult.styles?.reduce((s: number, st: any) => s + (st.total_qty || 0), 0) || 0} 件</span>
                    </div>
                  </div>
                  {/* 款式明细 */}
                  {poParseResult.styles?.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-green-200 space-y-1">
                      {poParseResult.styles.map((s: any, i: number) => (
                        <div key={i} className="text-xs text-gray-600">
                          <span className="font-medium">{s.style_no || `款${i + 1}`}</span>
                          {s.material && <span className="ml-2 text-gray-400">{s.material}</span>}
                          <span className="ml-2">{s.total_qty} 件</span>
                          <span className="ml-2 text-gray-400">
                            {(s.colors || []).map((c: any) => `${c.color_cn || c.color_en}(${c.qty})`).join(' / ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 置信度备注 */}
                  {poParseResult.confidence_notes?.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-green-200">
                      {poParseResult.confidence_notes.map((n: string, i: number) => (
                        <p key={i} className="text-xs text-amber-600">⚠ {n}</p>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-2">请核对以上信息，如有错误请手动修正表单字段</p>
                </div>
              )}
            </div>

            {/* 提交按钮上方的错误提示（确保用户能看到） */}
            {error && (
              <div ref={bottomErrorRef} className="rounded-lg bg-red-50 border border-red-300 p-4 text-sm text-red-800 animate-pulse">
                <span className="font-semibold">⚠ 创建失败：</span>{error}
              </div>
            )}

            {/* 历史导入字段 */}
            {isImport && (
              <div className="space-y-3 rounded-lg bg-amber-50 border border-amber-200 p-4">
                <input type="hidden" name="is_import" value="true" />
                <input type="hidden" name="import_current_step" value={importCurrentStep} />
                <p className="text-xs font-semibold text-amber-800">
                  ⚠ 进行中订单需要 CEO 审批后才能正式激活
                </p>
                <div>
                  <label className="block text-xs font-medium text-amber-700 mb-1">
                    导入原因 <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    name="import_reason"
                    rows={2}
                    required
                    placeholder="说明为什么要导入这个进行中的订单（例如：系统上线前已在生产的订单 / 从旧系统迁移 / 其他原因）"
                    className="w-full rounded-lg border border-amber-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>
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

      {/* 价格闸门弹窗 — Phase 1：三单价格不一致必须 CEO 审批 */}
      {showPriceGate && threeDocResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 border-4 border-red-500">
            <div className="flex items-start gap-3">
              <span className="text-3xl">🚨</span>
              <div>
                <h3 className="text-xl font-bold text-red-700">价格不一致 — 不能直接创建订单</h3>
                <p className="text-sm text-gray-700 mt-1">
                  AI 检测到「内部报价 / 客户报价 / 客户PO」的价格不一致。
                  按 CEO 规则，价格不一致的订单必须先和客户对齐 PO，
                  或推送 CEO 审批后才能创建。
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              <p className="font-medium">📋 AI 总结：</p>
              <p className="mt-1">{threeDocResult.summary || '价格字段在三份文件中存在差异'}</p>
            </div>

            {/* 价格差异明细表 */}
            {threeDocResult.priceDiffs.length > 0 && (
              <div className="rounded-lg border border-red-300 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-red-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-red-700">字段</th>
                      <th className="text-left px-3 py-2 font-medium text-red-700">内部报价</th>
                      <th className="text-left px-3 py-2 font-medium text-red-700">客户报价</th>
                      <th className="text-left px-3 py-2 font-medium text-red-700">客户 PO</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-red-100">
                    {threeDocResult.priceDiffs.map((d, i) => (
                      <tr key={i} className="bg-white">
                        <td className="px-3 py-2 font-medium text-gray-900">{d.field}</td>
                        <td className="px-3 py-2 text-gray-700">{d.internalValue || '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{d.customerQuoteValue || '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{d.poValue || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="space-y-2 text-sm text-gray-600">
              <p className="font-medium text-gray-900">下一步建议：</p>
              <ul className="list-disc list-inside space-y-1">
                <li><span className="font-medium">推荐</span>：联系客户修改 PO，让价格一致后重新上传</li>
                <li>或：推送 CEO 审批 — CEO 批准后可继续创建订单</li>
              </ul>
            </div>

            <div className="flex gap-3 justify-end pt-2 border-t border-gray-100">
              <button
                onClick={() => { setShowPriceGate(false); setPriceApprovalId(null); }}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
              >
                返回修改 PO
              </button>
              {priceApprovalId ? (
                <button
                  onClick={handleCheckApprovalAndRetry}
                  disabled={loading}
                  className="px-5 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                >
                  {loading ? '查询中...' : '✓ CEO 已批准，继续创建'}
                </button>
              ) : (
                <button
                  onClick={handleRequestPriceApproval}
                  disabled={loading}
                  className="px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {loading ? '推送中...' : '🚨 推送 CEO 审批'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 三单比对差异弹窗 */}
      {showThreeDocDialog && threeDocResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowThreeDocDialog(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6">
            <h3 className="text-lg font-bold text-red-700 mb-2">⚠️ 三单比对发现差异</h3>
            <p className="text-sm text-gray-600 mb-4">{threeDocResult.summary}</p>

            {threeDocResult.differences.length > 0 && (
              <div className="mb-4">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="text-left px-3 py-2 border">字段</th>
                      <th className="text-left px-3 py-2 border">内部报价</th>
                      <th className="text-left px-3 py-2 border">客户报价</th>
                      <th className="text-left px-3 py-2 border">客户PO</th>
                      <th className="text-left px-3 py-2 border">风险</th>
                    </tr>
                  </thead>
                  <tbody>
                    {threeDocResult.differences.map((d, i) => (
                      <tr key={i} className={d.severity === 'error' ? 'bg-red-50' : 'bg-yellow-50'}>
                        <td className="px-3 py-2 border font-medium">{d.field}</td>
                        <td className="px-3 py-2 border">{d.internalValue || '—'}</td>
                        <td className="px-3 py-2 border">{d.customerQuoteValue || '—'}</td>
                        <td className="px-3 py-2 border">{d.poValue || '—'}</td>
                        <td className="px-3 py-2 border text-xs text-red-600">{d.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {threeDocResult.risks.length > 0 && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3">
                <p className="text-sm font-medium text-red-800 mb-1">风险提示：</p>
                <ul className="text-sm text-red-700 space-y-1">
                  {threeDocResult.risks.map((r, i) => <li key={i}>· {r}</li>)}
                </ul>
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowThreeDocDialog(false)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">
                返回修改
              </button>
              <button onClick={handleIgnoreAndSubmit}
                className="px-4 py-2 rounded-lg bg-orange-500 text-sm text-white hover:bg-orange-600">
                已知晓差异，继续创建
              </button>
            </div>
          </div>
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

            {/* 文件类型自检 — 不是 PO 时强提示 */}
            {poVerifyResult.document_type_warning && (
              <div className="rounded-lg bg-red-100 border-2 border-red-400 p-4 text-sm text-red-800 font-medium">
                {poVerifyResult.document_type_warning}
                {poVerifyResult.confidence !== undefined && (
                  <div className="text-xs text-red-600 mt-1 font-normal">
                    AI 置信度：{poVerifyResult.confidence}/100
                  </div>
                )}
              </div>
            )}

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
                const isDone = isDoneStatus(m.status);
                const isActive = isActiveStatus(m.status);
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

      {/* ════ STEP 4：完成（兜底页，正常流程不会停留） ════ */}
      {currentStep === 4 && (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <div className="py-12">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-bold mb-2">订单创建成功！</h2>
            <div className="flex flex-col items-center gap-3 mt-4">
              {orderId ? (
                <Link href={'/orders/' + orderId}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors">
                  进入订单执行页 →
                </Link>
              ) : (
                <Link href="/orders"
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors">
                  返回订单列表
                </Link>
              )}
            </div>
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
