'use client';

/**
 * 生产主管一次性进度初始化客户端:逐单下拉选阶段档、即时保存;管理员可关闭入口。
 * 关闭后整页只读(下拉禁用、关闭按钮消失)。
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { STAGE_INIT_OPTIONS, STAGE_LABEL, type ProductionStage } from '@/lib/production/stage';
import { setOrderProductionStage, closeProductionStageInit, type StageInitRow } from '@/app/actions/production-stage-init';

function stageText(s: ProductionStage | 'done'): string {
  return s === 'done' ? '工厂已完工' : STAGE_LABEL[s];
}

function Row({ row, disabled }: { row: StageInitRow; disabled: boolean }) {
  const [manual, setManual] = useState<ProductionStage | 'done' | ''>(row.manual_stage ?? '');
  const [saved, setSaved] = useState<boolean>(!!row.manual_stage);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  function onChange(v: string) {
    const next = (v === '' ? null : (v as ProductionStage | 'done'));
    setManual((next ?? '') as any);
    setErr('');
    start(async () => {
      const res = await setOrderProductionStage(row.order_id, next);
      if (res.error) { setErr(res.error); setSaved(false); }
      else setSaved(true);
    });
  }

  const orderNo = row.internal_order_no || row.order_no || row.order_id;
  return (
    <tr className={`hover:bg-gray-50 ${saved ? '' : 'bg-amber-50/40'}`}>
      <td className="px-3 py-2.5">
        <Link href={`/production/order/${row.order_id}`} className="font-medium text-gray-900 hover:underline">{orderNo}</Link>
        <div className="text-xs text-gray-500">{row.customer_name || '—'}</div>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-gray-700">{row.quantity?.toLocaleString() ?? '—'}</td>
      <td className="px-3 py-2.5 text-gray-700">
        <div>{row.factory_name || <span className="text-gray-400">未指定</span>}</div>
        <div className="text-xs text-gray-500">{row.factory_date || '—'}</div>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500">{stageText(row.auto_stage)}</td>
      <td className="px-3 py-2.5">
        <select
          value={manual}
          disabled={disabled || pending}
          onChange={(e) => onChange(e.target.value)}
          className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:cursor-not-allowed disabled:bg-gray-100"
        >
          <option value="">— 用系统自动档 —</option>
          {STAGE_INIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <div className="mt-0.5 text-[11px]">
          {pending ? <span className="text-gray-400">保存中…</span>
            : err ? <span className="text-red-600">{err}</span>
            : saved && manual ? <span className="text-emerald-600">✓ 已设为 {stageText(manual as ProductionStage | 'done')}</span>
            : <span className="text-amber-600">待确认</span>}
        </div>
      </td>
    </tr>
  );
}

export function StageInitClient({ rows, open, isAdmin }: { rows: StageInitRow[]; open: boolean; isAdmin: boolean }) {
  const [closed, setClosed] = useState(!open);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState('');
  const disabled = closed;

  const doneCount = rows.filter((r) => r.manual_stage).length;

  async function onClose() {
    if (!confirm(`确认关闭进度初始化入口?关闭后本页只读、不能再改各单进度档。\n当前已设 ${doneCount}/${rows.length} 单。`)) return;
    setClosing(true); setCloseErr('');
    const res = await closeProductionStageInit();
    setClosing(false);
    if (res.error) setCloseErr(res.error);
    else setClosed(true);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-600">
          共 {rows.length} 单 · 已设手动档 <span className="font-semibold text-emerald-700">{doneCount}</span> 单
          {closed && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">入口已关闭 · 只读</span>}
        </div>
        {isAdmin && !closed && (
          <button onClick={onClose} disabled={closing}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
            {closing ? '关闭中…' : '关闭初始化入口'}
          </button>
        )}
      </div>
      {closeErr && <p className="mb-3 text-sm text-red-600">{closeErr}</p>}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white py-12 text-center text-gray-400">当前没有在产订单</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">订单 / 客户</th>
                <th className="px-3 py-2 font-medium">数量</th>
                <th className="px-3 py-2 font-medium">工厂 / 工厂期</th>
                <th className="px-3 py-2 font-medium">系统自动档</th>
                <th className="px-3 py-2 font-medium">生产主管设定档</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => <Row key={r.order_id} row={r} disabled={disabled} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
