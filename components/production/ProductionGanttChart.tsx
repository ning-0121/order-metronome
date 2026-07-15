'use client';

/**
 * 排产甘特图(生产进度可视化)——每个工厂一行,派工按排产窗口画成时间条,
 * 条内填充=完成进度(done/planned),超订单交期标红,今天一条竖线。一眼看清各厂负荷+进度+风险。
 * 数据复用 getFactoryScheduleBoard(P3):工厂 → 派工[含 order.factory_date / done_qty / 排产窗口]。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getFactoryScheduleBoard } from '@/app/actions/production-scheduling';

const DAY = 86400000;
const DAY_PX = 14;      // 每天像素宽
const BAR_H = 20;       // 时间条高
const LANE_GAP = 3;

function parseD(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
function daysBetween(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / DAY); }

// 车道打包:同厂内时间重叠的派工分到不同行,不叠在一起
function packLanes(items: any[]) {
  const laneEnds: number[] = [];
  const out = items.map((it) => {
    let lane = laneEnds.findIndex((end) => end <= it.startDay);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.endDay); }
    else laneEnds[lane] = it.endDay;
    return { ...it, lane };
  });
  return { out, laneCount: Math.max(1, laneEnds.length) };
}

export function ProductionGanttChart() {
  const [factories, setFactories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getFactoryScheduleBoard().then((r) => {
      setFactories((r as any).data?.factories || []);
      setLoading(false);
      if ((r as any).error) setMsg((r as any).error);
    });
  }, []);

  if (loading) return <div className="text-sm text-gray-400 py-6">加载排产甘特图…</div>;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 收集有排产窗口的派工,算时间范围
  const rows = factories.map((f) => {
    const disp = (f.dispatches || []).filter((d: any) => parseD(d.planned_start) && parseD(d.planned_end));
    const noWindow = (f.dispatches || []).length - disp.length;
    return { f, disp, noWindow };
  }).filter((r) => r.disp.length > 0 || r.noWindow > 0);

  const allDates: Date[] = [];
  for (const r of rows) for (const d of r.disp) { allDates.push(parseD(d.planned_start)!, parseD(d.planned_end)!); }
  if (allDates.length === 0) {
    return <div className="text-sm text-gray-400 py-6">暂无已排期的派工。到「排产工作台」派工并填排产窗口后,这里会出现甘特图。{msg && <span className="text-rose-600 ml-2">{msg}</span>}</div>;
  }
  let rangeStart = new Date(Math.min(...allDates.map((d) => d.getTime()), today.getTime()));
  let rangeEnd = new Date(Math.max(...allDates.map((d) => d.getTime()), today.getTime() + 30 * DAY));
  rangeStart = new Date(rangeStart.getTime() - 3 * DAY);
  rangeEnd = new Date(rangeEnd.getTime() + 3 * DAY);
  const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
  const width = totalDays * DAY_PX;
  const xOf = (d: Date) => daysBetween(rangeStart, d) * DAY_PX;

  // 月份分隔标签
  const months: { x: number; label: string }[] = [];
  const cur = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cur <= rangeEnd) {
    if (cur >= rangeStart) months.push({ x: xOf(cur), label: `${cur.getFullYear()}/${cur.getMonth() + 1}` });
    cur.setMonth(cur.getMonth() + 1);
  }

  const LABEL_W = 96;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-xs text-gray-500">
        <span className="font-bold text-sm text-gray-800">📅 排产甘特图</span>
        <span>条=派工·填充=完成进度·红=超交期·竖线=今天</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-indigo-400" />已排</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-blue-500" />生产中</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-rose-500" />超交期</span>
      </div>
      <div className="border border-gray-200 rounded-xl overflow-x-auto bg-white">
        <div style={{ width: width + LABEL_W, minWidth: '100%' }}>
          {/* 月份表头 */}
          <div className="relative h-6 border-b border-gray-100" style={{ marginLeft: LABEL_W }}>
            {months.map((m, i) => (
              <div key={i} className="absolute top-0 h-6 border-l border-gray-200 pl-1 text-[11px] text-gray-400" style={{ left: m.x }}>{m.label}</div>
            ))}
            {/* 今天线 */}
            <div className="absolute top-0 bottom-0 w-px bg-rose-400 z-10" style={{ left: xOf(today) }} title="今天" />
          </div>

          {/* 工厂行 */}
          {rows.map(({ f, disp, noWindow }) => {
            const items = disp.map((d: any) => {
              const s = parseD(d.planned_start)!, e = parseD(d.planned_end)!;
              return { d, startDay: daysBetween(rangeStart, s), endDay: daysBetween(rangeStart, e), x: xOf(s), w: Math.max(DAY_PX, (daysBetween(s, e) + 1) * DAY_PX) };
            }).sort((a, b) => a.startDay - b.startDay);
            const { out, laneCount } = packLanes(items);
            const rowH = laneCount * (BAR_H + LANE_GAP) + LANE_GAP;
            return (
              <div key={f.id} className="relative border-b border-gray-50" style={{ height: rowH }}>
                {/* 工厂名(粘左) */}
                <div className="absolute left-0 top-0 bottom-0 flex items-center px-2 bg-white z-20 border-r border-gray-100" style={{ width: LABEL_W }}>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-800 truncate">{f.factory_name}</div>
                    {noWindow > 0 && <div className="text-[10px] text-amber-500">{noWindow} 条未排窗口</div>}
                  </div>
                </div>
                {/* 今天线(行内) */}
                <div className="absolute top-0 bottom-0 w-px bg-rose-200 z-0" style={{ left: LABEL_W + xOf(today) }} />
                {/* 时间条 */}
                {out.map((it: any, i: number) => {
                  const d = it.d;
                  const planned = Number(d.planned_qty) || 0;
                  const done = Number(d.done_qty) || 0;
                  const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;
                  const fd = parseD(d.order?.factory_date);
                  const late = fd ? parseD(d.planned_end)! > fd : false;
                  const base = late ? 'bg-rose-200' : d.status === 'in_production' ? 'bg-blue-200' : 'bg-indigo-200';
                  const fill = late ? 'bg-rose-500' : d.status === 'in_production' ? 'bg-blue-500' : 'bg-indigo-400';
                  return (
                    <Link
                      key={i}
                      href={`/orders/${d.order_id}`}
                      title={`${d.order?.internal_order_no || d.order?.order_no || ''} ${d.style_no || '整单'}${d.color ? '·' + d.color : ''} | ${planned}件 完成${done}(${pct}%) | ${String(d.planned_start).slice(5)}~${String(d.planned_end).slice(5)}${late ? ' | ⚠超交期' + (fd ? String(fd.toISOString()).slice(5, 10) : '') : ''}`}
                      className={`absolute rounded ${base} overflow-hidden group`}
                      style={{ left: LABEL_W + it.x, width: it.w, height: BAR_H, top: LANE_GAP + it.lane * (BAR_H + LANE_GAP) }}
                    >
                      <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
                      <span className="absolute inset-0 flex items-center px-1 text-[10px] text-gray-700 whitespace-nowrap group-hover:underline">
                        {(d.order?.internal_order_no || d.order?.order_no || '').toString().slice(-6)} {d.style_no || '整单'} {planned}
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
