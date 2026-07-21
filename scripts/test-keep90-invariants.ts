/**
 * 「保持90」不变量契约测试(2026-07-21)。
 * 运行:npx tsx scripts/test-keep90-invariants.ts
 *
 * 锁定全链审计冲90修的关键不变量,防回归:分数不再反弹。
 *  1. 成交价必须入明细:buildLineItemsFromSnapshot 携带 approved 快照的 quoted_price_per_piece → po_unit_price(修 PI 单价=0)。
 *  2. 关键节点以模板 is_critical 为准:isMilestoneCritical 优先读 is_critical,仅空时回退硬编码(交付置信度不与UI徽章发散)。
 *  3. 佣金金额化:computeCommissionAmount = 基数 × 标准率 × 绩效系数。
 */

import { buildLineItemsFromSnapshot } from '../lib/order/from-po';
import { isMilestoneCritical } from '../lib/runtime/deliveryConfidence';
import { computeCommissionAmount, COMMISSION_BASE_RATE } from '../lib/domain/commission-config';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── 1. 成交价入明细(资金流·业务开发P0) ──
section('成交价必须入 order 明细(修 PI 单价=0)');
{
  const lines = buildLineItemsFromSnapshot([
    { style_no: 'S1', style_name: '款1', color: '黑', size_distribution: { S: 10, M: 20 }, quoted_price_per_piece: 12.5 },
    { style_no: 'S1', style_name: '款1', color: '白', size_distribution: { S: 5 }, quoted_price_per_piece: 12.5 },
    { style_no: 'S2', style_name: '款2', color: '红', size_distribution: { M: 8 }, quoted_price_per_piece: 30 },
  ]);
  const s1 = lines.find((l: any) => l.style_no === 'S1');
  const s2 = lines.find((l: any) => l.style_no === 'S2');
  assert(s1?.po_unit_price === 12.5, 'S1 明细带成交价 12.5(非0/非空)', JSON.stringify(s1?.po_unit_price));
  assert(s2?.po_unit_price === 30, 'S2 明细带成交价 30', JSON.stringify(s2?.po_unit_price));
  // 无价快照 → null(不崩、不写0充数)
  const noPrice = buildLineItemsFromSnapshot([{ style_no: 'S3', size_distribution: { S: 1 } }]);
  assert(noPrice[0].po_unit_price === null, '无 quoted_price → po_unit_price=null(不写0)');
}

// ── 2. 关键节点以模板 is_critical 为准(执行P1-1) ──
section('关键节点优先读模板 is_critical');
assert(isMilestoneCritical({ step_key: 'x_unknown', is_critical: true }) === true, 'is_critical=true → 关键(即便 step_key 不在硬编码)');
assert(isMilestoneCritical({ step_key: 'production_kickoff', is_critical: false }) === false, 'is_critical=false → 非关键(即便 step_key 在硬编码)');
assert(isMilestoneCritical({ step_key: 'production_kickoff' }) === true, 'is_critical 空 → 回退硬编码(production_kickoff=关键)');
assert(isMilestoneCritical({ step_key: 'x_unknown' }) === false, 'is_critical 空 + 非硬编码 → 非关键');

// ── 3. 佣金金额化(资金流·财务P1) ──
section('佣金金额 = 基数 × 标准率 × 绩效系数');
assert(COMMISSION_BASE_RATE > 0 && COMMISSION_BASE_RATE <= 0.2, `标准率 ${COMMISSION_BASE_RATE} 在合理区间(0,0.2]`);
{
  const base = 100000, mult = 1.1;
  const amt = computeCommissionAmount(base, mult);
  assert(amt === Math.round(base * COMMISSION_BASE_RATE * mult * 100) / 100, `${base}×${COMMISSION_BASE_RATE}×${mult} = ${amt}`, String(amt));
  assert(computeCommissionAmount(0, 1) === 0, '基数0 → 0');
  assert(computeCommissionAmount(100000, 0) === 0, '系数0(vetoed) → 0');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
