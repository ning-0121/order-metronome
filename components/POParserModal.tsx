'use client';

import { useState, useRef } from 'react';
import { parsePO, type POParsedData, type POStyleData } from '@/app/actions/po-parser';
import { generateProductionOrder } from '@/app/actions/generate-production-order';

interface POParserModalProps {
  orderId: string;
  onClose: () => void;
}

type Step = 'upload' | 'parsing' | 'preview' | 'generating' | 'done';
type InputMode = 'ai' | 'manual';

const EMPTY_DATA: POParsedData = {
  order_no: '',
  customer_name: '',
  delivery_date: '',
  order_date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
  styles: [{
    style_no: '',
    product_name: '',
    material: '',
    fabric_weight: '',
    total_qty: 0,
    colors: [{ color_cn: '', color_en: '', qty: 0, sizes: { S: 0, M: 0, L: 0 } }],
    packaging: '',
    quality_notes: '',
    sample_requirements: '',
  }],
  trims: [],
  size_labels: ['S', 'M', 'L'],
  confidence_notes: [],
};

export function POParserModal({ orderId, onClose }: POParserModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [inputMode, setInputMode] = useState<InputMode>('ai');
  const [error, setError] = useState('');
  const [data, setData] = useState<POParsedData | null>(null);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadName, setDownloadName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleManualStart = () => {
    setData(JSON.parse(JSON.stringify(EMPTY_DATA)));
    setStep('preview');
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError('请选择文件'); return; }
    setError('');
    setStep('parsing');

    const formData = new FormData();
    formData.append('file', file);

    const result = await parsePO(formData);
    if (!result.ok || !result.data) {
      setError(result.error || '解析失败');
      setStep('upload');
      return;
    }
    setData(result.data);
    setStep('preview');
  };

  const handleGenerate = async () => {
    if (!data) return;
    setStep('generating');

    const result = await generateProductionOrder(data);
    if (!result.ok || !result.base64) {
      setError(result.error || '生成失败');
      setStep('preview');
      return;
    }

    // Create download link
    const byteChars = atob(result.base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([new Uint8Array(byteNumbers)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setDownloadName(result.fileName || '生产单.xlsx');
    setStep('done');
  };

  const updateStyle = (idx: number, field: keyof POStyleData, value: string | number) => {
    if (!data) return;
    const styles = [...data.styles];
    (styles[idx] as Record<string, unknown>)[field] = value;
    setData({ ...data, styles });
  };

  const updateColor = (styleIdx: number, colorIdx: number, field: string, value: string | number) => {
    if (!data) return;
    const styles = [...data.styles];
    const colors = [...styles[styleIdx].colors];
    (colors[colorIdx] as Record<string, unknown>)[field] = value;
    styles[styleIdx] = { ...styles[styleIdx], colors };
    setData({ ...data, styles });
  };

  const updateSize = (styleIdx: number, colorIdx: number, sizeLabel: string, value: number) => {
    if (!data) return;
    const styles = [...data.styles];
    const colors = [...styles[styleIdx].colors];
    colors[colorIdx] = { ...colors[colorIdx], sizes: { ...colors[colorIdx].sizes, [sizeLabel]: value } };
    styles[styleIdx] = { ...styles[styleIdx], colors };
    setData({ ...data, styles });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 rounded-t-2xl flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-bold text-gray-900">AI 生成生产单</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {step === 'upload' && '上传客户 PO，AI 自动提取信息生成生产单'}
              {step === 'parsing' && 'AI 正在解析客户 PO...'}
              {step === 'preview' && '请检查提取结果，可直接编辑修正'}
              {step === 'generating' && '正在生成生产单 Excel...'}
              {step === 'done' && '生产单已生成，点击下载'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
          )}

          {/* Step 1: Upload or Manual */}
          {step === 'upload' && (
            <div className="space-y-4">
              {/* Mode tabs */}
              <div className="flex rounded-lg bg-gray-100 p-1">
                <button
                  onClick={() => setInputMode('ai')}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMode === 'ai' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}
                >
                  上传客户 PO（AI 解析）
                </button>
                <button
                  onClick={() => setInputMode('manual')}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${inputMode === 'manual' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}
                >
                  手动填写
                </button>
              </div>

              {inputMode === 'ai' ? (
                <>
                  <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center">
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp"
                      className="hidden"
                      id="po-file-input"
                      onChange={() => setError('')}
                    />
                    <label htmlFor="po-file-input" className="cursor-pointer">
                      <div className="text-4xl mb-3">📄</div>
                      <p className="text-sm font-medium text-gray-700">点击上传客户 PO</p>
                      <p className="text-xs text-gray-500 mt-1">支持 Excel、PDF、图片（拍照/扫描）</p>
                    </label>
                    {fileRef.current?.files?.[0] && (
                      <p className="mt-3 text-sm text-indigo-600 font-medium">
                        已选择：{fileRef.current.files[0].name}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={handleUpload}
                    className="w-full py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
                  >
                    开始解析
                  </button>
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-gray-50 p-6 text-center">
                    <div className="text-4xl mb-3">✏️</div>
                    <p className="text-sm font-medium text-gray-700">手动填写生产单信息</p>
                    <p className="text-xs text-gray-500 mt-1">没有客户 PO 时，直接输入数据生成生产单 Excel</p>
                  </div>
                  <button
                    onClick={handleManualStart}
                    className="w-full py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
                  >
                    开始填写
                  </button>
                </>
              )}
            </div>
          )}

          {/* Step 2: Parsing */}
          {step === 'parsing' && (
            <div className="py-12 text-center">
              <div className="inline-block w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-4" />
              <p className="text-sm text-gray-600">AI 正在解析客户 PO，请稍候...</p>
              <p className="text-xs text-gray-400 mt-1">通常需要 10-30 秒</p>
            </div>
          )}

          {/* Step 3: Preview & Edit */}
          {step === 'preview' && data && (
            <div className="space-y-6">
              {/* Confidence notes */}
              {data.confidence_notes?.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <p className="text-xs font-semibold text-amber-800 mb-1">AI 提示（请确认以下信息）：</p>
                  {data.confidence_notes.map((note, i) => (
                    <p key={i} className="text-xs text-amber-700">* {note}</p>
                  ))}
                </div>
              )}

              {/* Basic info */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-500">订单号</label>
                  <input
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={data.order_no}
                    onChange={(e) => setData({ ...data, order_no: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">客户名称</label>
                  <input
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={data.customer_name}
                    onChange={(e) => setData({ ...data, customer_name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">交期</label>
                  <input
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={data.delivery_date}
                    onChange={(e) => setData({ ...data, delivery_date: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500">下单日期</label>
                  <input
                    className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    value={data.order_date}
                    onChange={(e) => setData({ ...data, order_date: e.target.value })}
                  />
                </div>
              </div>

              {/* Styles */}
              {data.styles.map((style, si) => (
                <div key={si} className="border border-gray-200 rounded-xl p-4 space-y-3">
                  <p className="text-sm font-bold text-gray-900">款式 {si + 1}</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-500">款号</label>
                      <input className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" value={style.style_no} onChange={(e) => updateStyle(si, 'style_no', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500">品名</label>
                      <input className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" value={style.product_name} onChange={(e) => updateStyle(si, 'product_name', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500">总数量</label>
                      <input className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" type="number" value={style.total_qty} onChange={(e) => updateStyle(si, 'total_qty', Number(e.target.value))} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500">原料</label>
                      <input className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" value={style.material} onChange={(e) => updateStyle(si, 'material', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500">面料克重</label>
                      <input className="w-full mt-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm" value={style.fabric_weight} onChange={(e) => updateStyle(si, 'fabric_weight', e.target.value)} />
                    </div>
                  </div>

                  {/* Color/size table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="px-2 py-1.5 text-left border">颜色(中)</th>
                          <th className="px-2 py-1.5 text-left border">颜色(英)</th>
                          <th className="px-2 py-1.5 text-center border">数量</th>
                          {data.size_labels.map(s => (
                            <th key={s} className="px-2 py-1.5 text-center border">{s}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {style.colors.map((color, ci) => (
                          <tr key={ci}>
                            <td className="border px-1">
                              <input className="w-full px-1 py-1 text-xs border-0 focus:ring-1 focus:ring-indigo-400 rounded" value={color.color_cn} onChange={(e) => updateColor(si, ci, 'color_cn', e.target.value)} />
                            </td>
                            <td className="border px-1">
                              <input className="w-full px-1 py-1 text-xs border-0 focus:ring-1 focus:ring-indigo-400 rounded" value={color.color_en} onChange={(e) => updateColor(si, ci, 'color_en', e.target.value)} />
                            </td>
                            <td className="border px-1">
                              <input className="w-full px-1 py-1 text-xs text-center border-0 focus:ring-1 focus:ring-indigo-400 rounded" type="number" value={color.qty} onChange={(e) => updateColor(si, ci, 'qty', Number(e.target.value))} />
                            </td>
                            {data.size_labels.map(s => (
                              <td key={s} className="border px-1">
                                <input className="w-full px-1 py-1 text-xs text-center border-0 focus:ring-1 focus:ring-indigo-400 rounded" type="number" value={color.sizes[s] || 0} onChange={(e) => updateSize(si, ci, s, Number(e.target.value))} />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Add color button */}
                  <button
                    onClick={() => {
                      const newColor = { color_cn: '', color_en: '', qty: 0, sizes: Object.fromEntries(data.size_labels.map(s => [s, 0])) };
                      const styles = [...data.styles];
                      styles[si] = { ...styles[si], colors: [...styles[si].colors, newColor] };
                      setData({ ...data, styles });
                    }}
                    className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                  >
                    + 添加颜色
                  </button>

                  {/* Notes */}
                  <div>
                    <label className="text-xs font-medium text-gray-500">包装要求</label>
                    <textarea className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-xs" rows={2} value={style.packaging} onChange={(e) => updateStyle(si, 'packaging', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500">款式评语 / 质量要求</label>
                    <textarea className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-xs" rows={3} value={style.quality_notes} onChange={(e) => updateStyle(si, 'quality_notes', e.target.value)} />
                  </div>
                </div>
              ))}

              {/* Add style button */}
              <button
                onClick={() => {
                  const newStyle: POStyleData = {
                    style_no: '', product_name: '', material: '', fabric_weight: '',
                    total_qty: 0, colors: [{ color_cn: '', color_en: '', qty: 0, sizes: Object.fromEntries(data.size_labels.map(s => [s, 0])) }],
                    packaging: '', quality_notes: '', sample_requirements: '',
                  };
                  setData({ ...data, styles: [...data.styles, newStyle] });
                }}
                className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 text-sm text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
              >
                + 添加款式
              </button>

              <button
                onClick={handleGenerate}
                className="w-full py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
              >
                确认并生成生产单 Excel
              </button>
            </div>
          )}

          {/* Step 4: Generating */}
          {step === 'generating' && (
            <div className="py-12 text-center">
              <div className="inline-block w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-4" />
              <p className="text-sm text-gray-600">正在生成生产单 Excel...</p>
            </div>
          )}

          {/* Step 5: Done */}
          {step === 'done' && (
            <div className="py-8 text-center space-y-4">
              <div className="text-5xl">✅</div>
              <p className="text-sm font-medium text-gray-900">生产单已生成</p>
              <p className="text-xs text-gray-500">请下载后检查并微调，确认无误后上传到节点凭证区</p>
              <a
                href={downloadUrl}
                download={downloadName}
                className="inline-block px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
              >
                下载 {downloadName}
              </a>
              <div>
                <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">关闭</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
