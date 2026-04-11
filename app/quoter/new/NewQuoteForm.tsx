'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { previewQuote, saveQuote } from '@/app/actions/quoter';
import type { QuoteInput, QuoteOutput, GarmentType, StandardSize } from '@/lib/quoter/types';
import { GARMENT_TYPE_LABELS, SUBTYPE_LABELS } from '@/lib/quoter/types';
import { getChartOptions, DEFAULT_SIZE_CHARTS } from '@/lib/quoter/fabric/defaultSizeCharts';

export function NewQuoteForm() {
  const router = useRouter();

  // 基础信息
  const [customerName, setCustomerName] = useState('');
  const [styleNo, setStyleNo] = useState('');
  const [styleName, setStyleName] = useState('');
  const [garmentType, setGarmentType] = useState<GarmentType>('knit_top');
  const [chartKey, setChartKey] = useState<string>('knit_top_tshirt');
  const [quantity, setQuantity] = useState(1000);

  // 面料
  const [fabricType, setFabricType] = useState('单面平纹');
  const [fabricComposition, setFabricComposition] = useState('95%棉 5%氨纶');
  const [fabricWidth, setFabricWidth] = useState(175);
  const [fabricWeight, setFabricWeight] = useState(200);
  const [fabricPrice, setFabricPrice] = useState(48); // RMB/KG

  // 加工
  const [cmtFactory, setCmtFactory] = useState('');
  const [cmtComplexity, setCmtComplexity] = useState<'simple' | 'standard' | 'complex'>('standard');

  // 其他成本
  const [trimCost, setTrimCost] = useState(1.5);
  const [packingCost, setPackingCost] = useState(0.8);
  const [logisticsCost, setLogisticsCost] = useState(0);
  const [marginRate, setMarginRate] = useState(15);
  const [currency, setCurrency] = useState<'USD' | 'RMB' | 'EUR'>('USD');
  const [exchangeRate, setExchangeRate] = useState(7.2);

  // 计算状态
  const [calculating, setCalculating] = useState(false);
  const [result, setResult] = useState<QuoteOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 切换品类时自动切换默认尺码表
  function handleGarmentTypeChange(type: GarmentType) {
    setGarmentType(type);
    const firstChart = getChartOptions(type)[0];
    if (firstChart) {
      const key = Object.entries(DEFAULT_SIZE_CHARTS).find(
        ([, v]) => v === firstChart,
      )?.[0];
      if (key) setChartKey(key);
    }
  }

  function buildInput(): QuoteInput {
    const chart = DEFAULT_SIZE_CHARTS[chartKey];
    return {
      customer_name: customerName || undefined,
      style_no: styleNo || undefined,
      style_name: styleName || undefined,
      garment_type: garmentType,
      subtype: chart?.subtype,
      quantity: Number(quantity) || 0,
      size_chart: {
        garment_type: garmentType,
        primary_size: chart?.primary_size || 'M',
        sizes: chart?.sizes || {},
      },
      fabric: {
        fabric_type: fabricType,
        composition: fabricComposition,
        width_cm: Number(fabricWidth),
        weight_gsm: Number(fabricWeight),
        price_per_kg: Number(fabricPrice),
      },
      cmt_factory: cmtFactory || undefined,
      cmt_complexity: cmtComplexity,
      trim_cost_per_piece: Number(trimCost),
      packing_cost_per_piece: Number(packingCost),
      logistics_cost_per_piece: Number(logisticsCost),
      margin_rate: Number(marginRate),
      currency,
      exchange_rate: Number(exchangeRate),
    };
  }

  async function handlePreview() {
    setCalculating(true);
    setError(null);
    try {
      const input = buildInput();
      const r = await previewQuote(input);
      if (r.error) setError(r.error);
      else if (r.result) setResult(r.result);
    } catch (e: any) {
      setError(e?.message || '计算失败');
    }
    setCalculating(false);
  }

  async function handleSave() {
    if (!result) return;
    setSaving(true);
    try {
      const input = buildInput();
      const r = await saveQuote(input, result);
      if (r.error) {
        alert(r.error);
      } else {
        alert(`✅ 已保存：${r.quoteNo}`);
        router.push('/quoter');
      }
    } catch (e: any) {
      alert('保存失败：' + (e?.message || e));
    }
    setSaving(false);
  }

  const chartOptions = getChartOptions(garmentType);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* 左侧：输入表单 */}
      <div className="space-y-5">
        {/* 基础信息 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">① 基础信息</h2>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="客户名称"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={styleNo}
              onChange={e => setStyleNo(e.target.value)}
              placeholder="款号"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <input
            type="text"
            value={styleName}
            onChange={e => setStyleName(e.target.value)}
            placeholder="款式名称（如 女士七分瑜伽裤）"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">品类</label>
              <select
                value={garmentType}
                onChange={e => handleGarmentTypeChange(e.target.value as GarmentType)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                {(Object.keys(GARMENT_TYPE_LABELS) as GarmentType[]).map(t => (
                  <option key={t} value={t}>
                    {GARMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">尺码表</label>
              <select
                value={chartKey}
                onChange={e => setChartKey(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                {chartOptions.map(c => {
                  const key = Object.entries(DEFAULT_SIZE_CHARTS).find(
                    ([, v]) => v === c,
                  )?.[0];
                  return (
                    <option key={key} value={key}>
                      {c.label}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">数量（件）</label>
            <input
              type="number"
              value={quantity || ''}
              onChange={e => setQuantity(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </section>

        {/* 面料 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">② 面料参数</h2>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={fabricType}
              onChange={e => setFabricType(e.target.value)}
              placeholder="面料类型"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={fabricComposition}
              onChange={e => setFabricComposition(e.target.value)}
              placeholder="成分"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">幅宽 (cm)</label>
              <input
                type="number"
                value={fabricWidth || ''}
                onChange={e => setFabricWidth(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">克重 (gsm)</label>
              <input
                type="number"
                value={fabricWeight || ''}
                onChange={e => setFabricWeight(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">单价 ¥/KG</label>
              <input
                type="number"
                value={fabricPrice || ''}
                onChange={e => setFabricPrice(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </section>

        {/* 加工 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">③ 加工参数</h2>
          <input
            type="text"
            value={cmtFactory}
            onChange={e => setCmtFactory(e.target.value)}
            placeholder="加工厂（可选）"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <div>
            <label className="block text-xs text-gray-500 mb-1">复杂度</label>
            <div className="flex gap-2">
              {(['simple', 'standard', 'complex'] as const).map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCmtComplexity(c)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                    cmtComplexity === c
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {c === 'simple' ? '简单' : c === 'standard' ? '标准' : '复杂'}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 其他成本 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">④ 其他成本 (RMB/件)</h2>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">辅料</label>
              <input
                type="number"
                step="0.1"
                value={trimCost || ''}
                onChange={e => setTrimCost(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">包装</label>
              <input
                type="number"
                step="0.1"
                value={packingCost || ''}
                onChange={e => setPackingCost(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">物流</label>
              <input
                type="number"
                step="0.1"
                value={logisticsCost || ''}
                onChange={e => setLogisticsCost(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">利润率 %</label>
              <input
                type="number"
                step="0.5"
                value={marginRate || ''}
                onChange={e => setMarginRate(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">币种</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value as any)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                <option value="USD">USD</option>
                <option value="RMB">RMB</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">汇率</label>
              <input
                type="number"
                step="0.01"
                value={exchangeRate || ''}
                onChange={e => setExchangeRate(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </section>

        <button
          onClick={handlePreview}
          disabled={calculating}
          className="w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
        >
          {calculating ? '计算中...' : '🤖 AI 计算报价'}
        </button>
      </div>

      {/* 右侧：结果预览 */}
      <div className="space-y-5 lg:sticky lg:top-6 lg:self-start">
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!result && !error && (
          <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
            填完左侧参数后点击"AI 计算报价"查看结果
          </div>
        )}

        {result && (
          <>
            {/* 最终报价 */}
            <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 p-6 text-white">
              <div className="text-xs opacity-80 mb-1">最终报价 / 件</div>
              <div className="text-4xl font-bold">
                {currency} {result.quote_currency_per_piece.toFixed(3)}
              </div>
              <div className="text-xs opacity-80 mt-2">
                总额：{currency} {result.total_currency.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </div>
              <div className="mt-3 text-[11px] opacity-70">
                置信度：{result.overall_confidence}% · 利润率：{result.effective_margin_pct}%
              </div>
            </div>

            {/* 成本拆解 */}
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">成本拆解（RMB / 件）</h3>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">面料</span>
                  <span className="font-mono">{result.costs.fabric_rmb.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">加工费</span>
                  <span className="font-mono">{result.costs.cmt_rmb.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">辅料</span>
                  <span className="font-mono">{result.costs.trim_rmb.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">包装</span>
                  <span className="font-mono">{result.costs.packing_rmb.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">物流</span>
                  <span className="font-mono">{result.costs.logistics_rmb.toFixed(2)}</span>
                </div>
                <div className="flex justify-between border-t border-gray-100 pt-2 mt-2 font-semibold">
                  <span>小计</span>
                  <span className="font-mono">{result.costs.subtotal_rmb.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* 面料单耗 */}
            <details className="rounded-xl border border-gray-200 bg-white p-5" open>
              <summary className="text-sm font-semibold text-gray-800 cursor-pointer">
                🧵 面料单耗分析（置信度 {result.fabric.confidence}%）
              </summary>
              <div className="mt-3 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-gray-500">主码单耗</div>
                    <div className="text-lg font-bold text-gray-900">
                      {result.fabric.primary_size_kg.toFixed(3)} KG
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-gray-500">平均单耗</div>
                    <div className="text-lg font-bold text-gray-900">
                      {result.fabric.avg_kg.toFixed(3)} KG
                    </div>
                  </div>
                </div>
                <pre className="whitespace-pre-wrap text-gray-600 font-sans leading-relaxed bg-gray-50 p-3 rounded-lg">
                  {result.fabric.reasoning}
                </pre>
              </div>
            </details>

            {/* 加工费 */}
            <details className="rounded-xl border border-gray-200 bg-white p-5">
              <summary className="text-sm font-semibold text-gray-800 cursor-pointer">
                ✂️ 加工费拆解（{result.cmt.operations.length} 道工序，置信度 {result.cmt.confidence}%）
              </summary>
              <div className="mt-3">
                <div className="max-h-64 overflow-auto text-xs border border-gray-100 rounded-lg">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-gray-500 font-medium">工序</th>
                        <th className="px-3 py-2 text-right text-gray-500 font-medium">工价</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {result.cmt.operations.map(op => (
                        <tr key={op.code}>
                          <td className="px-3 py-1.5">{op.name}</td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {op.adjusted_rate.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 font-semibold">
                      <tr>
                        <td className="px-3 py-2">合计</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {result.cmt.total_rmb.toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {/* 历史依据 — 展示匹配的历史订单 */}
                {(result.cmt as any).rag_samples?.length > 0 && (
                  <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 p-3">
                    <p className="text-xs font-semibold text-blue-800 mb-2">📋 历史依据（同类款式加工费参考）</p>
                    <div className="space-y-1.5">
                      {(result.cmt as any).rag_samples.map((s: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-blue-700">
                            {s.source_order_id ? (
                              <a href={`/orders/${s.source_order_id}`} className="hover:underline" target="_blank">
                                {s.style_no}
                              </a>
                            ) : s.style_no}
                            {s.customer_name && <span className="text-blue-500 ml-1">({s.customer_name})</span>}
                            {s.factory_name && <span className="text-blue-400 ml-1">· {s.factory_name}</span>}
                          </span>
                          <span className="font-mono font-semibold text-blue-800">
                            ¥{s.total_rmb.toFixed(2)}
                            {s.created_at && <span className="text-blue-400 ml-1 font-normal">{s.created_at}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                    {(result.cmt as any).labor_rate_median && (
                      <p className="text-[10px] text-blue-500 mt-2 pt-2 border-t border-blue-200">
                        工价中位数 ¥{(result.cmt as any).labor_rate_median.toFixed(2)} + 工厂利润 ¥{((result.cmt as any).factory_profit || 1.25).toFixed(2)} = 加工费基准
                        {(result.cmt as any).formula_total && ` · 公式参考 ¥${(result.cmt as any).formula_total.toFixed(2)}`}
                        {(result.cmt as any).deviation_pct != null && ` · 偏差 ${(result.cmt as any).deviation_pct}%`}
                      </p>
                    )}
                  </div>
                )}
                <pre className="whitespace-pre-wrap text-xs text-gray-600 font-sans leading-relaxed bg-gray-50 p-3 rounded-lg mt-2">
                  {result.cmt.reasoning}
                </pre>
              </div>
            </details>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? '保存中...' : '💾 保存报价'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
