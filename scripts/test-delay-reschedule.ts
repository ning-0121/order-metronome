/**
 * 延期改期数学单测(2026-07-09)。验证延期引擎依赖的纯排期函数:
 *   顺延交期 = calcDueDates(新锚点=原+N) → 交期节点后移 N,不越界
 *   保交期   = recalcRemainingDueDates(节点, 锚点, 节点新日期) → 下游压进 [新日期, 锚点],不越交期
 */
import { calcDueDates, compressRemainingIntoWindow } from '../lib/schedule';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); } }
function iso(d: Date) { return d.toISOString().slice(0, 10); }
function addStr(base: string, n: number) { const d = new Date(base + 'T00:00:00+08:00'); d.setDate(d.getDate() + n); return iso(d); }
function calDays(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / 86400000); }

const orderDate = '2026-03-02';
const anchor0 = addStr(orderDate, 45);

console.log('══════ 延期改期数学 ══════');

// ── 顺延交期:锚点 +7 ──
console.log('\n▶ 顺延交期(+7天)');
const due0 = calcDueDates({ orderDate, createdAt: new Date(orderDate + 'T00:00:00+08:00'), incoterm: 'FOB', etd: anchor0 });
const anchor1 = addStr(anchor0, 7);
const due1 = calcDueDates({ orderDate, createdAt: new Date(orderDate + 'T00:00:00+08:00'), incoterm: 'FOB', etd: anchor1 });
check('出运节点后移(顺延后 > 顺延前)', due1.shipment_execute.getTime() > due0.shipment_execute.getTime());
const shipShift = calDays(due0.shipment_execute, due1.shipment_execute);
check('出运后移约 7 天(±2)', shipShift >= 5 && shipShift <= 9, `实移 ${shipShift} 天`);
check('出运贴近新交期(交期−3 内)', calDays(due1.shipment_execute, new Date(anchor1 + 'T00:00:00+08:00')) <= 3, `距新交期 ${calDays(due1.shipment_execute, new Date(anchor1 + 'T00:00:00+08:00'))} 天`);
const noOver1 = Object.entries(due1).every(([k, d]) => k === 'payment_received' || (d as Date).getTime() <= new Date(anchor1 + 'T00:00:00+08:00').getTime() + 86400000);
check('无节点越过新交期', noOver1);

// ── 保交期:开裁被延到 day35 位置,下游压进 [新日期, 锚点] ──
console.log('\n▶ 保交期(开裁延后,下游压缩)');
const anchorD = new Date(anchor0 + 'T00:00:00+08:00');
const delayedKickoff = new Date(addStr(orderDate, 38) + 'T00:00:00+08:00');   // 开裁被拖到很晚
const compressed = compressRemainingIntoWindow('production_kickoff', delayedKickoff, anchorD);
const keys = Object.keys(compressed);
check('有下游节点被重算', keys.length > 0, `${keys.length} 个`);
const allWithin = keys.every(k => compressed[k].getTime() <= anchorD.getTime() + 86400000);
check('下游全部不越交期', allWithin, keys.filter(k => compressed[k].getTime() > anchorD.getTime() + 86400000).join(','));
// 出运应压到最接近锚点
if (compressed['shipment_execute']) {
  check('出运压到锚点附近(≤ 交期)', compressed['shipment_execute'].getTime() <= anchorD.getTime() + 86400000);
}
// 顺序:工厂完成 ≤ 出运
if (compressed['factory_completion'] && compressed['shipment_execute']) {
  check('工厂完成 ≤ 出运(顺序不倒)', compressed['factory_completion'].getTime() <= compressed['shipment_execute'].getTime());
}

console.log(`\n────────────────\n通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('❌ 有失败'); process.exit(1); } else console.log('✅ 全部通过');
