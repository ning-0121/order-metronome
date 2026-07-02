/**
 * 库存 SC-P2 单测 — 可用量真相层(纯)
 * 运行：npx tsx scripts/test-inventory-scp2.ts
 * available = onHand − reserved − safety;只 reserved 占用;取消/消耗不占;可为负;不双计。
 */

import {
  availableToPromise, reservedByKey, computeAvailability,
  type ReservationRow, type InvBalance,
} from '../lib/services/inventory';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

section('availableToPromise');
assert(availableToPromise({ onHand: 1000, reserved: 300, safety: 100 }) === 600, '1000 − 300 − 100 = 600');
assert(availableToPromise({ onHand: 500, reserved: 0 }) === 500, '无预留无安全 → onHand');
assert(availableToPromise({ onHand: 100, reserved: 150, safety: 0 }) === -50, '超预留 → 负(−50,不钳)');

section('reservedByKey(只 reserved 占用)');
const resv: ReservationRow[] = [
  { material_key: 'k1', qty: 200, status: 'reserved' },
  { material_key: 'k1', qty: 100, status: 'reserved' }, // 同料累加
  { material_key: 'k1', qty: 999, status: 'released' },  // 取消 → 不占
  { material_key: 'k1', qty: 999, status: 'consumed' },  // 已消耗 → 不占
  { material_key: 'k2', qty: 50, status: 'reserved' },
];
const rmap = reservedByKey(resv);
assert(rmap.get('k1') === 300, 'k1 预留 = 200+100 = 300(released/consumed 不计)', `${rmap.get('k1')}`);
assert(rmap.get('k2') === 50, 'k2 预留 50');
assert(reservedByKey([]).size === 0, '空 → 空');

section('computeAvailability(余额+预留+安全)');
const balance: InvBalance[] = [
  { material_key: 'k1', material_name: '面料X', unit: 'KG', on_hand: 1000 },
  { material_key: 'k2', material_name: '辅料Y', unit: 'PCS', on_hand: 40 },
  { material_key: 'k3', material_name: 'Z', unit: 'M', on_hand: 500 },
];
const safety = new Map<string, number>([['k1', 100]]);
const rows = computeAvailability(balance, resv, safety);
const k1 = rows.find(r => r.material_key === 'k1')!;
assert(k1.reserved === 300 && k1.safety === 100 && k1.available === 600, 'k1: 1000 res300 safe100 → avail600');
assert(k1.shortage === 0, 'k1 无缺口');
const k2 = rows.find(r => r.material_key === 'k2')!;
assert(k2.reserved === 50 && k2.available === -10 && k2.shortage === 10, 'k2: 40 res50 → avail−10, 缺口10');
const k3 = rows.find(r => r.material_key === 'k3')!;
assert(k3.reserved === 0 && k3.safety === 0 && k3.available === 500, 'k3: 无预留无安全 → avail=onHand');

section('不双计 / 边界');
assert(computeAvailability([], resv).length === 0, '空余额 → 空');
const dbl = computeAvailability([{ material_key: 'k1', material_name: null, unit: null, on_hand: 300 }],
  [{ material_key: 'k1', qty: 300, status: 'reserved' }]);
assert(dbl[0].on_hand === 300, '预留不改 onHand(仍 300)');
assert(dbl[0].available === 0, '可用 = 300 − 300 = 0(预留只减可用,不双计)', `${dbl[0].available}`);

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
