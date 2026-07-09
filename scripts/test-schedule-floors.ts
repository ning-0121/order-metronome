/**
 * 关键工序工期地板单测(2026-07-09)。
 * 验证:比例挤压后,关键工序仍保证最小工作日间隔,且不越锚点(交期)。
 */
import { calcDueDates } from '../lib/schedule';

const FLOORS: Array<[string, string, number]> = [
  ['procurement_order_placed', 'materials_received_inspected', 4],
  ['production_kickoff', 'factory_completion', 12],
  ['pre_production_sample_ready', 'pre_production_sample_approved', 5],
  ['factory_completion', 'inspection_release', 2],
  ['booking_done', 'shipment_execute', 2],
];

function iso(d: Date) { return d.toISOString().slice(0, 10); }
function addDaysStr(base: string, n: number) { const d = new Date(base + 'T00:00:00+08:00'); d.setDate(d.getDate() + n); return iso(d); }
function calDays(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / 86400000); }

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); } }

function run(label: string, windowDays: number, expectFloors: boolean) {
  console.log(`\n▶ ${label}(窗口 ${windowDays} 天)${expectFloors ? '' : ' —— 窗口过紧,地板尽力压缩,只校验结构不越界'}`);
  const orderDate = '2026-03-02';                 // 周一
  const etd = addDaysStr(orderDate, windowDays);   // FOB 锚点=出厂/ETD
  const anchor = new Date(etd + 'T00:00:00+08:00');
  const due = calcDueDates({ orderDate, createdAt: new Date(orderDate + 'T00:00:00+08:00'), incoterm: 'FOB', etd });

  // 1) 可行窗口:每个地板 from→to 的日历间隔 ≥ 工作日下限(工作日≥N ⇒ 日历≥N)
  if (expectFloors) for (const [from, to, biz] of FLOORS) {
    const f = due[from], t = due[to];
    if (!f || !t) { check(`${from}→${to} 存在`, false, '节点缺失'); continue; }
    const gap = calDays(f, t);
    check(`${from}→${to} 间隔 ≥ ${biz}(实 ${gap} 天)`, gap >= biz);
  }
  // 2) 除收款外无节点晚于锚点
  const over = Object.entries(due).filter(([k, d]) => k !== 'payment_received' && (d as Date).getTime() > anchor.getTime() + 86400000);
  check('无节点晚于交期', over.length === 0, over.map(([k]) => k).join(','));
  // 3) 无节点早于下单日
  const t0 = new Date(orderDate + 'T00:00:00+08:00');
  const early = Object.entries(due).filter(([k, d]) => k !== 'payment_received' && (d as Date).getTime() < t0.getTime());
  check('无节点早于下单日', early.length === 0, early.map(([k]) => k).join(','));
}

console.log('══════ 关键工序工期地板 ══════');
run('宽松窗口', 60, true);
run('标准窗口', 45, true);
run('紧窗口', 28, true);
run('极紧窗口', 20, false);   // 20天窗口装不下(生产工期就要12工作日),地板尽力压,只校验不越界

console.log(`\n────────────────\n通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('❌ 有失败'); process.exit(1); } else console.log('✅ 全部通过');
