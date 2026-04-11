'use client';

import { useState, useEffect, useRef } from 'react';
import {
  uploadCostSheet,
  getCostControlSummary,
  sendCostAlert,
  autoParseExistingCostSheet,
  type CostControlSummary,
} from '@/app/actions/cost-control';

interface Props {
  orderId: string;
  orderNo: string;
  styleNo?: string;
  quantity: number;
  isAdmin: boolean;
  canEdit: boolean;
}

export function CostControlTab({ orderId, orderNo, styleNo, quantity, isAdmin, canEdit }: Props) {
  const [summary, setSummary] = useState<CostControlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [orderId]);

  async function load() {
    setLoading(true);
    // 先尝试自动解析已上传的内部成本核算单（业务员创建订单时已传）
    await autoParseExistingCostSheet(orderId).catch(() => {});
    const res = await getCostControlSummary(orderId);
    if (res.data) setSummary(res.data);
    setLoading(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const res = await uploadCostSheet(orderId, file, styleNo);
    if (res.error) {
      alert('解析失败：' + res.error);
    } else {
      alert(
        `✅ 解析成功\n款号：${res.data?.style}\n` +
        `单耗：${res.data?.fabric_consumption_kg} KG/件\n` +
        `加工费：¥${res.data?.cmt_price}\n` +
        `面料预算：${res.data?.budget_kg} KG` +
        (res.data?.warnings?.length > 0 ? `\n\n⚠ 警告：${res.data.warnings.join('; ')}` : ''),
      );
      load();
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploading(false);
  }

  async function handleSendAlert(type: 'procurement_over_budget' | 'cmt_over_estimate', msg: string) {
    await sendCostAlert(orderId, type, msg);
    alert('⚠ 已通知责任人 + 财务 + CEO');
  }

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;

  const b = summary?.baseline;
  const hasBaseline = !!b;

  return (
    <div className="space-y-5">
      {/* 上传内部成本核算单 */}
      {canEdit && (
        <div className="rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/30 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-800">📊 上传内部成本核算单</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Excel 格式（成本核算单-内部审核版），系统自动提取单耗/克重/加工费/净布价
              </p>
            </div>
            <label className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 cursor-pointer">
              {uploading ? '解析中...' : hasBaseline ? '🔄 重新上传' : '📥 上传解析'}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleUpload}
                className="hidden"
                disabled={uploading}
              />
            </label>
          </div>
          {hasBaseline && (
            <p className="text-xs text-green-600 mt-2">
              ✅ 已解析：{b.source_file_name}（{new Date(b.parsed_at).toLocaleDateString('zh-CN')}）
            </p>
          )}
        </div>
      )}

      {/* 警报 */}
      {summary?.alerts && summary.alerts.length > 0 && (
        <div className="space-y-2">
          {summary.alerts.map((alert, i) => (
            <div
              key={i}
              className={`rounded-xl border p-4 flex items-start justify-between ${
                alert.level === 'red'
                  ? 'bg-red-50 border-red-200'
                  : 'bg-amber-50 border-amber-200'
              }`}
            >
              <div>
                <p className={`text-sm font-semibold ${alert.level === 'red' ? 'text-red-800' : 'text-amber-800'}`}>
                  {alert.title}
                </p>
                <p className={`text-xs mt-0.5 ${alert.level === 'red' ? 'text-red-700' : 'text-amber-700'}`}>
                  {alert.message}
                </p>
              </div>
              {alert.level === 'red' && (
                <span className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-red-100 text-red-700 ml-3">
                  已自动通知财务+CEO
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!hasBaseline ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          请先上传内部成本核算单（Excel），系统会自动建立成本基线。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* 面料成本 */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              🧵 面料成本控制
              {summary?.procurement.budgetCheck?.status === 'over_limit' && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">超标</span>}
              {summary?.procurement.budgetCheck?.status === 'ok' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">正常</span>}
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">单件用量</span>
                <span className="font-mono">{b.fabric_area_m2} m² × {b.fabric_weight_kg_m2} KG/m² = <strong>{b.fabric_consumption_kg} KG/件</strong></span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">净布价</span>
                <span className="font-mono">¥{b.fabric_price_per_kg}/KG</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">订单数量</span>
                <span className="font-mono">{quantity} 件</span>
              </div>
              <div className="flex justify-between border-t border-gray-100 pt-2">
                <span className="text-gray-500">预算用量（含 {b.waste_pct}% 损耗）</span>
                <span className="font-mono font-semibold text-indigo-700">{b.budget_fabric_kg} KG</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">预算金额</span>
                <span className="font-mono font-semibold text-indigo-700">¥{b.budget_fabric_amount?.toLocaleString()}</span>
              </div>

              {summary?.procurement.totalOrderedKg > 0 && (
                <>
                  <div className="border-t border-gray-100 pt-2" />
                  <div className="flex justify-between">
                    <span className="text-gray-500">实际采购</span>
                    <span className={`font-mono font-semibold ${
                      summary.procurement.budgetCheck?.status === 'over_limit' ? 'text-red-600' :
                      summary.procurement.budgetCheck?.status === 'warning' ? 'text-amber-600' : 'text-gray-800'
                    }`}>
                      {summary.procurement.totalOrderedKg} KG
                      {summary.procurement.budgetCheck && ` (${summary.procurement.budgetCheck.deviationPct > 0 ? '+' : ''}${summary.procurement.budgetCheck.deviationPct}%)`}
                    </span>
                  </div>
                  {summary?.procurement.totalReceivedKg > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">实际到货</span>
                      <span className="font-mono">{summary.procurement.totalReceivedKg} KG</span>
                    </div>
                  )}
                </>
              )}

              {b.actual_fabric_used_kg && (
                <>
                  <div className="border-t border-gray-100 pt-2" />
                  <div className="flex justify-between">
                    <span className="text-gray-500">实际用量</span>
                    <span className="font-mono font-semibold">{b.actual_fabric_used_kg} KG</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">实际单耗</span>
                    <span className="font-mono font-semibold">{b.actual_consumption_kg} KG/件</span>
                  </div>
                </>
              )}
            </div>

            {/* 瀑布进度条 */}
            {b.budget_fabric_kg > 0 && (
              <div className="mt-4 space-y-1">
                <div className="flex gap-1 text-[10px] text-gray-400">
                  <span className="flex-1">预算 {b.budget_fabric_kg} KG</span>
                  {summary?.procurement.totalOrderedKg > 0 && (
                    <span>采购 {summary.procurement.totalOrderedKg}</span>
                  )}
                </div>
                <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
                  {/* 预算基准线 */}
                  <div className="absolute left-0 top-0 h-full bg-indigo-200 rounded-full" style={{ width: '100%' }} />
                  {/* 采购数量 */}
                  {summary?.procurement.totalOrderedKg > 0 && (
                    <div
                      className={`absolute left-0 top-0 h-full rounded-full ${
                        (summary.procurement.budgetCheck?.status === 'over_limit') ? 'bg-red-500' :
                        (summary.procurement.budgetCheck?.status === 'warning') ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(120, (summary.procurement.totalOrderedKg / b.budget_fabric_kg) * 100)}%` }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 加工费 */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              ✂️ 加工费控制
              {summary?.cmt.cmtCheck?.status === 'over_limit' && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">偏高</span>}
              {summary?.cmt.cmtCheck?.status === 'ok' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">正常</span>}
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">工厂报价</span>
                <span className="font-mono font-semibold">¥{b.cmt_factory_quote || b.cmt_internal_estimate || '—'}/件</span>
              </div>
              {b.cmt_internal_estimate && b.cmt_factory_quote && (
                <div className="flex justify-between">
                  <span className="text-gray-500">内部估价</span>
                  <span className="font-mono">¥{b.cmt_internal_estimate}/件</span>
                </div>
              )}
              {b.cmt_labor_rate && (
                <div className="flex justify-between">
                  <span className="text-gray-500">工人工价</span>
                  <span className="font-mono text-gray-400">¥{b.cmt_labor_rate}/件</span>
                </div>
              )}
              {summary?.cmt.cmtCheck && (
                <div className={`mt-2 p-2 rounded-lg text-xs ${
                  summary.cmt.cmtCheck.status === 'over_limit' ? 'bg-red-50 text-red-700' :
                  summary.cmt.cmtCheck.status === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'
                }`}>
                  {summary.cmt.cmtCheck.message}
                </div>
              )}
              {/* 加工费进度条 */}
              {b.cmt_internal_estimate && b.cmt_factory_quote && (
                <div className="mt-3 space-y-1">
                  <div className="flex gap-1 text-[10px] text-gray-400">
                    <span className="flex-1">内部估价 ¥{b.cmt_internal_estimate}</span>
                    <span>工厂报价 ¥{b.cmt_factory_quote}</span>
                  </div>
                  <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="absolute left-0 top-0 h-full bg-indigo-200 rounded-full" style={{ width: '100%' }} />
                    <div
                      className={`absolute left-0 top-0 h-full rounded-full ${
                        summary?.cmt.cmtCheck?.status === 'over_limit' ? 'bg-red-500' :
                        summary?.cmt.cmtCheck?.status === 'warning' ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(120, (b.cmt_factory_quote / b.cmt_internal_estimate) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="border-t border-gray-100 pt-2">
                <div className="flex justify-between">
                  <span className="text-gray-500">单件总成本</span>
                  <span className="font-mono font-semibold">¥{b.total_cost_per_piece || '—'}</span>
                </div>
                {b.fob_price && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">FOB 报价</span>
                    <span className="font-mono">${b.fob_price}</span>
                  </div>
                )}
                {b.ddp_price && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">DDP 报价</span>
                    <span className="font-mono">${b.ddp_price}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
