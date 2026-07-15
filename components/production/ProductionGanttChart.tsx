'use client';

/**
 * 排产甘特图(生产进度可视化 V2)——直接吃生产中心在产订单(工厂+工厂期+开裁/完成节点),
 * 不再依赖手动派工记录,傲狐等已在产工厂的单立刻显示。每厂一行,订单按「开裁→工厂完成/工厂期」画时间条,
 * 阶段映射进度填充,逾期标红,今天一条竖线。数据由 page 传入(复用生产中心已加载的 rows)。
 */

import { useState } from 'react';
import Link from 'next/link';

const DAY = 86400000;
const DAY_PX = 12;
const BAR_H = 22;
const LANE_GAP = 4;

function parseD(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
function daysBetween(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / DAY); }
function addD(d: Date, n: number) { return new Date(d.getTime() + n * DAY); }

const STAGE_PCT: Record<string, number> = {
  awaiting_procurement: 8, materials_in_transit: 30, ready_to_schedule: 50, in_production: 75, ready_to_ship: 95,
};
const DONE = (s?: string | null) => ['done', '已完成', 'completed'].includes(String(s || '').toLowerCase());

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

export function ProductionGanttChart({ rows }: { rows: any[] }) {
  const [onlyRisk, setOnlyRisk] = useState(false);

  const today = new Date(); today.setHours(0, 0, 0, 0);

  // 每单算时间窗:end=工厂完成计划||工厂期;start=开裁计划||end-21天
  const withWin = (rows || []).map((r) => {
    const end = parseD(r.completion?.due) || parseD(r.factory_date);
    let start = parseD(r.kickoff?.due);
    if (!start && end) start = addD(end, -21);
    if (start && end && start > end) start = addD(end, -14);
    return { r, start, end };
  }).filter((x) => x.start && x.end);

  const shown = onlyRisk ? withWin.filter((x) => x.r.risk) : withWin;

  // 按工厂分组
  const byFactory = new Map<string, any[]>();
  for (const x of shown) {
    const f = x.r.factory_name || '未指定工厂';
    byFactory.set(f, [...(byFactory.get(f) || []), x]);
  }
  const factories = [...byFactory.entries()].sort((a, b) => b[1].length - a[1].length);

  if (withWin.length === 0) {
    return <div className="text-sm text-gray-400 py-6">暂无可排期的在产订单(需订单填了工厂期/开裁计划)。</div>;
  }

  const allDates: Date[] = [];
  for (const x of shown) { allDates.push(x.start!, x.end!); }
  let rangeStart = new Date(Math.min(...allDates.map((d) => d.getTime()), today.getTime()));
  let rangeEnd = new Date(Math.max(...allDates.map((d) => d.getTime()), today.getTime() + 20 * DAY));
  rangeStart = addD(rangeStart, -4); rangeEnd = addD(rangeEnd, 4);
  const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
  const width = totalDays * DAY_PX;
  const xOf = (d: Date) => daysBetween(rangeStart, d) * DAY_PX;
  const LABEL_W = 104;

  const months: { x: number; label: string }[] = [];
  const cur = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cur <= rangeEnd) { if (cur >= rangeStart) months.push({ x: xOf(cur), label: `${cur.getMonth() + 1}月` }); cur.setMonth(cur.getMonth() + 1); }

  const riskN = withWin.filter((x) => x.r.risk).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-bold text-sm text-gray-800">📊 排产甘特图</span>
        <span className="text-xs text-gray-400">工厂×时间·条内填充=阶段进度·红=逾期·竖线=今天</span>
        <button onClick={() => setOnlyRisk(!onlyRisk)} className={`ml-auto text-xs px-2.5 py-1 rounded-full font-medium transition ${onlyRisk ? 'bg-rose-500 text-white' : 'bg-rose-50 text-rose-600 border border-rose-200'}`}>
          {onlyRisk ? '显示全部' : `只看逾期 (${riskN})`}
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white overflow-x-auto shadow-sm">
        <div style={{ width: width + LABEL_W, minWidth: '100%' }} className="relative">
          {/* 月份网格线(贯穿全高) */}
          {months.map((m, i) => (
            <div key={`g${i}`} className="absolute top-0 bottom-0 border-l border-slate-100 z-0" style={{ left: LABEL_W + m.x }} />
          ))}
          {/* 今天线(贯穿) */}
          <div className="absolute top-0 bottom-0 z-10" style={{ left: LABEL_W + xOf(today) }}>
            <div className="w-px h-full bg-gradient-to-b from-rose-400/80 to-rose-500/40" />
            <span className="absolute -top-0.5 -translate-x-1/2 text-[9px] px-1 rounded bg-rose-500 text-white whitespace-nowrap">今天</span>
          </div>

          {/* 月份表头 */}
          <div className="relative h-7 border-b border-slate-200" style={{ marginLeft: LABEL_W }}>
            {months.map((m, i) => (
              <div key={i} className="absolute top-0 h-7 flex items-center pl-1.5 text-[11px] font-medium text-slate-400" style={{ left: m.x }}>{m.label}</div>
            ))}
          </div>

          {/* 工厂行 */}
          {factories.map(([fname, items]) => {
            const mapped = items.map((x: any) => ({
              x, startDay: daysBetween(rangeStart, x.start), endDay: daysBetween(rangeStart, x.end),
              px: xOf(x.start), w: Math.max(DAY_PX, (daysBetween(x.start, x.end) + 1) * DAY_PX),
            })).sort((a: any, b: any) => a.startDay - b.startDay);
            const { out, laneCount } = packLanes(mapped);
            const rowH = laneCount * (BAR_H + LANE_GAP) + LANE_GAP;
            const total = items.reduce((s: number, x: any) => s + (Number(x.r.quantity) || 0), 0);
            return (
              <div key={fname} className="relative border-b border-slate-100" style={{ height: rowH }}>
                {/* 工厂名(粘左) */}
                <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-center px-2.5 bg-white/90 backdrop-blur z-20 border-r border-slate-200" style={{ width: LABEL_W }}>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                    <span className="text-xs font-semibold text-slate-700 truncate">{fname}</span>
                  </div>
                  <span className="text-[10px] text-slate-400 ml-3">{items.length}单·{(total / 10000).toFixed(1)}万件</span>
                </div>
                {/* 时间条 */}
                {out.map((it: any, i: number) => {
                  const r = it.x.r;
                  const pct = DONE(r.completion?.status) ? 100 : DONE(r.kickoff?.status) ? Math.max(70, STAGE_PCT[r.stage] || 50) : (STAGE_PCT[r.stage] || 10);
                  const late = !!r.risk;
                  const grad = late ? 'from-rose-400 to-rose-500' : pct >= 100 ? 'from-emerald-400 to-emerald-500'
                    : r.stage === 'in_production' ? 'from-blue-400 to-indigo-500' : 'from-indigo-300 to-indigo-400';
                  const no = (r.internal_order_no || r.order_no || '').toString();
                  return (
                    <Link
                      key={i}
                      href={`/orders/${r.order_id}`}
                      title={`${no} ${r.customer_name || ''} · ${r.quantity || 0}件 · ${STAGE_PCT[r.stage] != null ? '阶段' : ''}进度~${pct}%\n开裁 ${r.kickoff?.due || '—'} → 完成 ${r.completion?.due || r.factory_date || '—'}${late ? '\n⚠ 逾期(开裁/完成节点)' : ''}`}
                      className={`absolute rounded-md bg-gradient-to-r ${grad} shadow-sm ring-1 ring-black/5 overflow-hidden group hover:brightness-110 transition`}
                      style={{ left: LABEL_W + it.px, width: it.w, height: BAR_H, top: LANE_GAP + it.lane * (BAR_H + LANE_GAP) }}
                    >
                      {/* 进度填充(更亮的一段) */}
                      <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${pct}%` }} />
                      <span className="absolute inset-0 flex items-center px-1.5 text-[10px] font-medium text-white/95 whitespace-nowrap drop-shadow-sm">
                        {no.slice(-6)} · {pct}%
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-slate-400">
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-gradient-to-r from-indigo-300 to-indigo-400" />备产/待开裁</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-gradient-to-r from-blue-400 to-indigo-500" />生产中</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-gradient-to-r from-emerald-400 to-emerald-500" />已完成</span>
        <span className="flex items-center gap-1"><i className="inline-block w-3 h-2.5 rounded-sm bg-gradient-to-r from-rose-400 to-rose-500" />逾期</span>
        <span>· 进度为阶段估算;填了排产窗口+录实绩(排产工作台)后可精确到件数。</span>
      </div>
    </div>
  );
}
