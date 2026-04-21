'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  attributeDelay,
  getDelayHotspots,
  type DelayedMilestoneRow,
  type HotspotAggregate,
} from '@/app/actions/delay-hotspots';
import { DELAY_REASON_LABEL, type DelayReasonType } from '@/lib/constants/delay-reasons';

interface Props {
  initialRows: DelayedMilestoneRow[];
  initialSummary?: HotspotAggregate;
  initialError?: string;
}

// 阻塞点中文名（复用自治理台，去掉偏门）
const STEP_LABEL: Record<string, string> = {
  po_confirmed: 'PO 确认',
  finance_approval: '财务审批',
  order_kickoff_meeting: '订单启动会',
  production_order_upload: '上传采购单',
  order_docs_bom_complete: '订单资料齐',
  bulk_materials_confirmed: '大货面料确认',
  processing_fee_confirmed: '工费确认',
  factory_confirmed: '工厂确认',
  procurement_order_placed: '采购下单',
  materials_received_inspected: '原料到货检验',
  pre_production_sample_ready: '产前样完成',
  pre_production_sample_sent: '产前样寄出',
  pre_production_sample_approved: '产前样确认',
  pre_production_meeting: '产前会',
  production_kickoff: '大货启动',
  mid_qc_check: '中期验货',
  mid_qc_sales_check: '中期验货（业务）',
  final_qc_check: '尾期验货',
  final_qc_sales_check: '尾期验货（业务）',
  packing_method_confirmed: '包装确认',
  factory_completion: '大货完工',
  finished_goods_warehouse: '成品入库',
  inspection_release: '放行',
  leftover_collection: '余料回收',
  shipping_sample_send: '出运样寄出',
  booking_done: '订舱完成',
  domestic_delivery: '国内交货',
  customs_export: '清关出运',
  shipment_execute: '出运执行',
  payment_received: '尾款到账',
  finance_shipment_approval: '财务出运审批',
};
const stepLabel = (k: string) => STEP_LABEL[k] || k;

const REASON_COLOR: Record<DelayReasonType, string> = {
  upstream: 'bg-blue-100 text-blue-800',
  customer_change: 'bg-purple-100 text-purple-800',
  internal: 'bg-red-100 text-red-800',
  force_majeure: 'bg-gray-100 text-gray-800',
  other: 'bg-amber-100 text-amber-800',
};

function severity(days: number) {
  if (days >= 14) return 'bg-red-100 text-red-800';
  if (days >= 7) return 'bg-orange-100 text-orange-800';
  if (days >= 3) return 'bg-amber-100 text-amber-800';
  return 'bg-yellow-50 text-yellow-800';
}

export function DelayHotspotsClient({ initialRows, initialSummary, initialError }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [summary, setSummary] = useState(initialSummary);
  const [error, setError] = useState(initialError);
  const [range, setRange] = useState<number>(30);
  const [filter, setFilter] = useState<{
    ownerId?: string;
    stepKey?: string;
    onlyUnattributed?: boolean;
  }>({});
  const [loading, startLoading] = useTransition();

  // 归因弹层
  const [target, setTarget] = useState<DelayedMilestoneRow | null>(null);
  const [formState, setFormState] = useState<{ reason: DelayReasonType; note: string }>({
    reason: 'upstream',
    note: '',
  });
  const [submitting, startSubmit] = useTransition();
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (filter.ownerId === '__none__' && r.owner_user_id) return false;
      if (filter.ownerId && filter.ownerId !== '__none__' && r.owner_user_id !== filter.ownerId) return false;
      if (filter.stepKey && r.step_key !== filter.stepKey) return false;
      if (filter.onlyUnattributed && r.reason_type) return false;
      return true;
    });
  }, [rows, filter]);

  const reload = (newRange?: number) => {
    const r = newRange ?? range;
    startLoading(async () => {
      const result = await getDelayHotspots({ rangeDays: r, minDelayDays: 1 });
      if (result.error) {
        setError(result.error);
      } else {
        setRows(result.data || []);
        setSummary(result.summary);
        setError(undefined);
      }
    });
  };

  const openAttribute = (row: DelayedMilestoneRow) => {
    setTarget(row);
    setFormState({
      reason: (row.reason_type as DelayReasonType) || 'upstream',
      note: row.reason_note || '',
    });
    setMsg(null);
  };

  const submitAttribution = () => {
    if (!target) return;
    startSubmit(async () => {
      const r = await attributeDelay(target.milestone_id, formState.reason, formState.note);
      if (r.error) {
        setMsg({ type: 'err', text: r.error });
      } else {
        setMsg({ type: 'ok', text: '归因已保存' });
        setTimeout(() => {
          setTarget(null);
          reload();
          router.refresh();
        }, 600);
      }
    });
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 时间范围 */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600">统计范围：</span>
        {[7, 30, 90, 0].map(n => (
          <button
            key={n}
            onClick={() => { setRange(n); reload(n); }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              range === n ? 'bg-blue-600 text-white' : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
            disabled={loading}
          >
            {n === 0 ? '全部' : `近 ${n} 天`}
          </button>
        ))}
        {loading && <span className="text-sm text-gray-400">加载中…</span>}
      </div>

      {/* 汇总卡 */}
      {summary && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="延误完成关卡数" value={summary.total_delayed} tone="rose" />
          <SummaryCard
            label="未归因数"
            value={summary.total_unattributed}
            hint={summary.total_delayed > 0
              ? `${Math.round((summary.total_unattributed / summary.total_delayed) * 100)}% 待处理`
              : ''}
            tone="amber"
          />
          <SummaryCard label="累计延误天数" value={summary.total_delay_days_sum} hint={`平均 ${summary.avg_delay_days} 天/条`} tone="orange" />
          <SummaryCard
            label="最常见关卡"
            value={summary.by_step[0]?.count || 0}
            hint={summary.by_step[0] ? stepLabel(summary.by_step[0].step_key) : '—'}
            tone="purple"
          />
        </div>
      )}

      {/* 双排行榜 */}
      {summary && summary.total_delayed > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RankCard title="🏭 关卡延误 Top 5" items={summary.by_step.slice(0, 5).map(s => ({
            label: stepLabel(s.step_key),
            count: s.count,
            days: s.total_delay_days,
            subLabel: `平均 ${s.avg_delay_days} 天`,
          }))} />
          <RankCard title="👤 责任人延误 Top 5" items={summary.by_owner.slice(0, 5).map(o => ({
            label: o.owner_name || '（未分派）',
            count: o.count,
            days: o.total_delay_days,
            subLabel: `${o.count} 条 · ${o.total_delay_days} 天`,
          }))} />
        </div>
      )}

      {/* 归因分布 */}
      {summary && summary.total_delayed > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-gray-700">归因分布</div>
          <div className="flex flex-wrap gap-2">
            {summary.by_reason.map(r => {
              const label = r.reason_type === 'unattributed'
                ? '⚠️ 未归因'
                : DELAY_REASON_LABEL[r.reason_type as DelayReasonType];
              const color = r.reason_type === 'unattributed'
                ? 'bg-amber-50 text-amber-800 border-amber-200'
                : `${REASON_COLOR[r.reason_type as DelayReasonType]} border-transparent`;
              return (
                <span key={r.reason_type} className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${color}`}>
                  {label}：{r.count}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={filter.ownerId || ''}
          onChange={(e) => setFilter(f => ({ ...f, ownerId: e.target.value || undefined }))}
        >
          <option value="">全部负责人</option>
          {summary?.by_owner.map(o => (
            <option key={o.owner_user_id || '__none__'} value={o.owner_user_id || '__none__'}>
              {o.owner_name || '（未分派）'}（{o.count}）
            </option>
          ))}
        </select>

        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={filter.stepKey || ''}
          onChange={(e) => setFilter(f => ({ ...f, stepKey: e.target.value || undefined }))}
        >
          <option value="">全部关卡</option>
          {summary?.by_step.map(s => (
            <option key={s.step_key} value={s.step_key}>{stepLabel(s.step_key)}（{s.count}）</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={!!filter.onlyUnattributed}
            onChange={(e) => setFilter(f => ({ ...f, onlyUnattributed: e.target.checked || undefined }))}
          />
          只看未归因
        </label>

        <div className="ml-auto text-sm text-gray-500">
          匹配 <span className="font-bold text-gray-900">{filteredRows.length}</span> / {rows.length}
        </div>
      </div>

      {/* 明细表 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <Th>延误</Th>
              <Th>订单</Th>
              <Th>客户</Th>
              <Th>关卡</Th>
              <Th>计划/实际</Th>
              <Th>负责人</Th>
              <Th>归因</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-gray-500">✨ 暂无延误记录</td>
              </tr>
            )}
            {filteredRows.map(row => (
              <tr key={row.milestone_id} className={`hover:bg-gray-50 ${!row.reason_type ? 'bg-amber-50/40' : ''}`}>
                <td className="px-3 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${severity(row.delay_days)}`}>
                    +{row.delay_days} 天
                  </span>
                </td>
                <td className="px-3 py-3">
                  <Link href={`/orders/${row.order_id}`} className="font-mono text-blue-600 hover:underline">
                    {row.order_no}
                  </Link>
                </td>
                <td className="px-3 py-3 text-gray-900">{row.customer_name || '—'}</td>
                <td className="px-3 py-3 text-gray-900">{stepLabel(row.step_key)}</td>
                <td className="px-3 py-3 text-xs text-gray-500">
                  <div>计划：{new Date(row.due_at).toLocaleDateString('zh-CN')}</div>
                  <div>实际：{new Date(row.actual_at).toLocaleDateString('zh-CN')}</div>
                </td>
                <td className="px-3 py-3 text-gray-900">{row.owner_name || <span className="text-gray-400">未分派</span>}</td>
                <td className="px-3 py-3">
                  {row.reason_type ? (
                    <div>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${REASON_COLOR[row.reason_type]}`}>
                        {DELAY_REASON_LABEL[row.reason_type]}
                      </span>
                      {row.reason_note && (
                        <div className="mt-1 max-w-xs text-xs text-gray-500 line-clamp-2">{row.reason_note}</div>
                      )}
                      {row.attributed_by && (
                        <div className="mt-0.5 text-[10px] text-gray-400">{row.attributed_by}</div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs font-medium text-amber-600">⚠️ 未归因</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <button
                    onClick={() => openAttribute(row)}
                    className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                  >
                    {row.reason_type ? '✏️ 改归因' : '📝 归因'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 归因弹层 */}
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setTarget(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="text-lg font-bold text-gray-900">延误归因</div>
              <div className="mt-1 text-sm text-gray-500">
                {target.order_no} · {stepLabel(target.step_key)} · <span className="text-red-600 font-semibold">延误 {target.delay_days} 天</span>
              </div>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">归因类型</label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(DELAY_REASON_LABEL) as DelayReasonType[]).map(t => (
                    <label
                      key={t}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        formState.reason === t
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio" name="reason" value={t}
                        checked={formState.reason === t}
                        onChange={() => setFormState(s => ({ ...s, reason: t }))}
                        className="sr-only"
                      />
                      <span>{DELAY_REASON_LABEL[t]}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">补充说明（可选）</label>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="例：面料供应商延迟 10 天发货，已换备用供应商"
                  value={formState.note}
                  onChange={(e) => setFormState(s => ({ ...s, note: e.target.value }))}
                />
              </div>

              {msg && (
                <div className={`rounded-md border px-3 py-2 text-sm ${
                  msg.type === 'ok' ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {msg.text}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">
              <button
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => setTarget(null)}
                disabled={submitting}
              >
                取消
              </button>
              <button
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={submitAttribution}
                disabled={submitting}
              >
                {submitting ? '保存中…' : '保存归因'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">{children}</th>;
}

function SummaryCard({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone: 'rose' | 'amber' | 'orange' | 'purple' }) {
  const tones = {
    rose: 'from-rose-500 to-rose-600',
    amber: 'from-amber-500 to-amber-600',
    orange: 'from-orange-500 to-orange-600',
    purple: 'from-purple-500 to-purple-600',
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`mt-2 bg-gradient-to-br ${tones[tone]} bg-clip-text text-3xl font-bold text-transparent`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function RankCard({ title, items }: { title: string; items: { label: string; count: number; days: number; subLabel?: string }[] }) {
  if (items.length === 0) return null;
  const max = Math.max(...items.map(i => i.days), 1);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-gray-700">{title}</div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-5 text-xs font-semibold text-gray-400">#{i + 1}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between text-sm">
                <span className="truncate font-medium text-gray-900">{item.label}</span>
                <span className="ml-2 shrink-0 text-xs text-gray-500">{item.subLabel}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full bg-gradient-to-r from-orange-400 to-rose-500"
                  style={{ width: `${(item.days / max) * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
