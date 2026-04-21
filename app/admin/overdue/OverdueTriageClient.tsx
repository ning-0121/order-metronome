'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  forceCompleteBlockMilestone,
  transferOrderOwner,
  pauseOverdueOrder,
  resumeOverdueOrder,
  shiftOrderSchedule,
  type OverdueRow,
  type OverdueSummary,
} from '@/app/actions/overdue-triage';

interface Props {
  initialRows: OverdueRow[];
  initialSummary?: OverdueSummary;
  initialError?: string;
  candidates: { user_id: string; name: string; role: string }[];
}

type ActionKind = 'force' | 'transfer' | 'pause' | 'shift' | null;

// 关卡中文名 — 仅常见阻塞点
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

function stepLabel(key: string) {
  return STEP_LABEL[key] || key;
}

function severity(days: number): { bg: string; text: string; label: string } {
  if (days >= 30) return { bg: 'bg-red-100', text: 'text-red-800', label: '🔴 严重' };
  if (days >= 14) return { bg: 'bg-orange-100', text: 'text-orange-800', label: '🟠 高' };
  if (days >= 7) return { bg: 'bg-amber-100', text: 'text-amber-800', label: '🟡 中' };
  return { bg: 'bg-yellow-50', text: 'text-yellow-800', label: '⚪ 低' };
}

export function OverdueTriageClient({ initialRows, initialSummary, initialError, candidates }: Props) {
  const router = useRouter();
  const [rows] = useState(initialRows);
  const [filter, setFilter] = useState<{ ownerId?: string | null; stepKey?: string; minDays?: number }>({});
  const [activeRow, setActiveRow] = useState<OverdueRow | null>(null);
  const [actionKind, setActionKind] = useState<ActionKind>(null);
  const [formState, setFormState] = useState({
    reason: '',
    newOwner: '',
    shiftDays: 0,
  });
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (filter.ownerId === '__none__' && r.owner_user_id) return false;
      if (filter.ownerId && filter.ownerId !== '__none__' && r.owner_user_id !== filter.ownerId) return false;
      if (filter.stepKey && r.block_step_key !== filter.stepKey) return false;
      if (filter.minDays && r.overdue_days < filter.minDays) return false;
      return true;
    });
  }, [rows, filter]);

  const openAction = (row: OverdueRow, kind: ActionKind) => {
    setActiveRow(row);
    setActionKind(kind);
    setFormState({ reason: '', newOwner: '', shiftDays: kind === 'shift' ? 7 : 0 });
    setMsg(null);
  };

  const closeModal = () => {
    setActiveRow(null);
    setActionKind(null);
    setFormState({ reason: '', newOwner: '', shiftDays: 0 });
  };

  const runAction = () => {
    if (!activeRow || !actionKind) return;
    const row = activeRow;
    const reason = formState.reason.trim();
    if (!reason) {
      setMsg({ type: 'err', text: '请填写原因' });
      return;
    }

    startTransition(async () => {
      let result: { error?: string; shifted_count?: number } = {};
      if (actionKind === 'force') {
        result = await forceCompleteBlockMilestone(row.block_milestone_id, reason);
      } else if (actionKind === 'transfer') {
        if (!formState.newOwner) {
          setMsg({ type: 'err', text: '请选择新负责人' });
          return;
        }
        result = await transferOrderOwner(row.order_id, formState.newOwner, reason);
      } else if (actionKind === 'pause') {
        result = await pauseOverdueOrder(row.order_id, reason);
      } else if (actionKind === 'shift') {
        if (!formState.shiftDays) {
          setMsg({ type: 'err', text: '请输入偏移天数' });
          return;
        }
        result = await shiftOrderSchedule(row.order_id, formState.shiftDays, reason);
      }

      if (result.error) {
        setMsg({ type: 'err', text: result.error });
      } else {
        const ok = actionKind === 'shift'
          ? `已顺延 ${result.shifted_count} 个关卡`
          : '操作成功';
        setMsg({ type: 'ok', text: ok });
        setTimeout(() => {
          closeModal();
          router.refresh();
        }, 800);
      }
    });
  };

  const resume = (orderId: string) => {
    if (!confirm('确定恢复该订单吗？')) return;
    startTransition(async () => {
      const r = await resumeOverdueOrder(orderId);
      if (r.error) alert(r.error);
      else router.refresh();
    });
  };

  if (initialError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {initialError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 汇总卡片 */}
      {initialSummary && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="逾期订单数" value={initialSummary.total_orders} tone="red" />
          <SummaryCard label="逾期关卡总数" value={initialSummary.total_overdue_rows} tone="orange" />
          <SummaryCard
            label="最严重负责人"
            value={initialSummary.by_owner[0]?.count || 0}
            hint={initialSummary.by_owner[0]?.owner_name || '—'}
            tone="amber"
          />
          <SummaryCard
            label="最常见阻塞点"
            value={initialSummary.by_step_key[0]?.count || 0}
            hint={initialSummary.by_step_key[0] ? stepLabel(initialSummary.by_step_key[0].step_key) : '—'}
            tone="yellow"
          />
        </div>
      )}

      {/* 筛选 */}
      <div className="flex flex-wrap gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={filter.ownerId || ''}
          onChange={(e) => setFilter(f => ({ ...f, ownerId: e.target.value || undefined }))}
        >
          <option value="">全部负责人</option>
          <option value="__none__">— 无负责人 —</option>
          {initialSummary?.by_owner.map(o => (
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
          <option value="">全部阻塞点</option>
          {initialSummary?.by_step_key.map(s => (
            <option key={s.step_key} value={s.step_key}>
              {stepLabel(s.step_key)}（{s.count}）
            </option>
          ))}
        </select>

        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={filter.minDays || 0}
          onChange={(e) => setFilter(f => ({ ...f, minDays: Number(e.target.value) || undefined }))}
        >
          <option value={0}>全部逾期</option>
          <option value={7}>≥ 7 天</option>
          <option value={14}>≥ 14 天</option>
          <option value={30}>≥ 30 天</option>
        </select>

        <div className="ml-auto text-sm text-gray-500 self-center">
          匹配 <span className="font-bold text-gray-900">{filtered.length}</span> / {rows.length} 张订单
        </div>
      </div>

      {/* 列表 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <Th>严重度</Th>
              <Th>订单</Th>
              <Th>客户</Th>
              <Th>阻塞点</Th>
              <Th>逾期</Th>
              <Th>负责人</Th>
              <Th>级联</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                  ✨ 没有匹配的逾期订单
                </td>
              </tr>
            )}
            {filtered.map(row => {
              const sev = severity(row.overdue_days);
              return (
                <tr key={row.order_id} className="hover:bg-gray-50">
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sev.bg} ${sev.text}`}>
                      {sev.label}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/orders/${row.order_id}`} className="font-mono text-blue-600 hover:underline">
                      {row.order_no}
                    </Link>
                    {row.lifecycle_status === 'paused' && (
                      <div className="mt-0.5 text-xs text-gray-500">⏸ 已暂停</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-gray-900">{row.customer_name || '—'}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-gray-900">{stepLabel(row.block_step_key)}</div>
                    <div className="text-xs text-gray-500">{new Date(row.block_due_at).toLocaleDateString('zh-CN')}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="font-bold text-red-600">{row.overdue_days}</span>
                    <span className="text-xs text-gray-500"> 天</span>
                  </td>
                  <td className="px-3 py-3 text-gray-900">{row.owner_name || <span className="text-gray-400">未分派</span>}</td>
                  <td className="px-3 py-3">
                    {row.downstream_overdue > 0 ? (
                      <span className="text-xs text-gray-500">+{row.downstream_overdue} 连锁</span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      <ActionBtn onClick={() => openAction(row, 'force')} tone="green">✓ 完成</ActionBtn>
                      <ActionBtn onClick={() => openAction(row, 'transfer')} tone="blue">↷ 转派</ActionBtn>
                      <ActionBtn onClick={() => openAction(row, 'shift')} tone="purple">⏩ 顺延</ActionBtn>
                      {row.lifecycle_status === 'paused' ? (
                        <ActionBtn onClick={() => resume(row.order_id)} tone="gray">▶ 恢复</ActionBtn>
                      ) : (
                        <ActionBtn onClick={() => openAction(row, 'pause')} tone="amber">⏸ 暂停</ActionBtn>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 动作弹层 */}
      {activeRow && actionKind && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="text-lg font-bold text-gray-900">
                {actionKind === 'force' && '强制完成关卡'}
                {actionKind === 'transfer' && '转派订单'}
                {actionKind === 'pause' && '暂停订单'}
                {actionKind === 'shift' && '顺延排期'}
              </div>
              <div className="mt-1 text-sm text-gray-500">
                {activeRow.order_no} · {activeRow.customer_name || '—'} · 阻塞点 {stepLabel(activeRow.block_step_key)}
              </div>
            </div>

            <div className="space-y-4 px-6 py-5">
              {actionKind === 'transfer' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">新负责人</label>
                  <select
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={formState.newOwner}
                    onChange={(e) => setFormState(f => ({ ...f, newOwner: e.target.value }))}
                  >
                    <option value="">— 请选择 —</option>
                    {candidates
                      .filter(c => c.user_id !== activeRow.owner_user_id)
                      .map(c => (
                        <option key={c.user_id} value={c.user_id}>{c.name}（{c.role}）</option>
                      ))}
                  </select>
                </div>
              )}

              {actionKind === 'shift' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">顺延天数（正数）</label>
                  <input
                    type="number"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={formState.shiftDays}
                    onChange={(e) => setFormState(f => ({ ...f, shiftDays: Number(e.target.value) }))}
                    min={-365} max={365}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    将把该订单所有未完成关卡的 due_at / planned_at 整体后移（负数=前移）。已完成关卡不变。
                  </p>
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  原因（审计记录）<span className="text-red-500">*</span>
                </label>
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={3}
                  placeholder={
                    actionKind === 'force' ? '例：工费已线下确认，补标系统' :
                    actionKind === 'transfer' ? '例：原负责人休假，临时转派' :
                    actionKind === 'pause' ? '例：客户确认延期发货一周' :
                    '例：模板起始日期错锚，整体顺延 46 天'
                  }
                  value={formState.reason}
                  onChange={(e) => setFormState(f => ({ ...f, reason: e.target.value }))}
                />
              </div>

              {msg && (
                <div className={`rounded-md border px-3 py-2 text-sm ${
                  msg.type === 'ok'
                    ? 'border-green-200 bg-green-50 text-green-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {msg.text}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">
              <button
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={closeModal}
                disabled={pending}
              >
                取消
              </button>
              <button
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={runAction}
                disabled={pending}
              >
                {pending ? '处理中…' : '确认执行'}
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

function SummaryCard({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone: 'red' | 'orange' | 'amber' | 'yellow' }) {
  const tones = {
    red: 'from-red-500 to-red-600',
    orange: 'from-orange-500 to-orange-600',
    amber: 'from-amber-500 to-amber-600',
    yellow: 'from-yellow-500 to-yellow-600',
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

function ActionBtn({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone: 'green' | 'blue' | 'purple' | 'amber' | 'gray' }) {
  const tones = {
    green: 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100',
    blue: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
    purple: 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100',
    amber: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
    gray: 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100',
  };
  return (
    <button onClick={onClick} className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${tones[tone]}`}>
      {children}
    </button>
  );
}
