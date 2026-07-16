'use client';

import Link from 'next/link';
import type { ProductionOrderRow } from '@/app/actions/production-center';
import { classifyProductionTasks, type WorkbenchRole } from '@/lib/production/workbench';

export function RoleTaskWorkbench({ rows, role }: { rows: ProductionOrderRow[]; role: WorkbenchRole }) {
  const tasks = rows.flatMap((row) => classifyProductionTasks(row, role).map((task) => ({ row, task })))
    .sort((a, b) => Number(b.task.urgent) - Number(a.task.urgent));
  const title = role === 'supervisor' ? '生产主管今日任务' : role === 'qc' ? 'QC 今日任务' : '生产跟单今日任务';
  return (
    <section className="mb-6 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
      <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-gray-900">{title}</h2><span className="text-sm text-indigo-700">{tasks.length} 项</span></div>
      {tasks.length === 0 ? <p className="text-sm text-gray-500">当前没有待办任务。</p> : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {tasks.slice(0, 24).map(({ row, task }) => (
            <Link key={`${row.order_id}-${task.key}`} href={task.href} className={`rounded-lg border bg-white p-3 hover:shadow-sm ${task.urgent ? 'border-red-200' : 'border-gray-200'}`}>
              <div className="flex justify-between gap-2"><span className="font-medium text-gray-900">{task.label}</span><span className="text-xs text-indigo-600">去处理 →</span></div>
              <div className="mt-1 text-sm text-gray-700">{row.order_no || row.internal_order_no || '—'} · {row.customer_name || '—'}</div>
              <div className="text-xs text-gray-500">内部单号: {row.internal_order_no || '—'} · PO: {row.po_number || '—'} · 款号: {row.style_no || '—'}</div>
              <div className="text-xs text-gray-500">总负责人: {row.business_execution_owner_name || '—'} · 生产主管: {row.production_manager_owner_name || '—'} · 跟单/QC: {row.follow_up_name || '—'}</div>
              <div className="mt-1 text-xs text-gray-500">原因: {task.reason}；下一步: {task.action}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
