/**
 * Day 3 单元测试 — Delivery Confidence 引擎
 *
 * 运行：
 *   npx tsx scripts/test-runtime-confidence.ts
 *
 * 覆盖 case：
 *   1. 正常订单 → green ≥ 85
 *   2. 非关键节点逾期 → 仅小幅扣分，仍 green/yellow
 *   3. 关键节点超期 → 明显扣分进入 yellow/orange
 *   4. blocked + 无延期 → red < 50（强制低分）
 *   5. 关键节点延期已批准 + buffer 够 → yellow，不应直接 red
 *   附加 6. 已出运 + 尾款待收 → 不算排期，主要看付款
 *   附加 7. 出厂日已过 + 货物未出 → red 严重
 */

import { computeDeliveryConfidence } from '../lib/runtime/deliveryConfidence';

// ──────────────────────────────────────────────────────────
// 简易断言
// ──────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`);
    fail++;
    failures.push(label);
  }
}

function section(name: string) {
  console.log(`\n▶ ${name}`);
}

// ──────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────

const NOW = new Date('2026-05-06T08:00:00Z');

function ms(stepKey: string, name: string, due: string, status = 'in_progress', extra: any = {}) {
  return {
    id: `m-${stepKey}`,
    step_key: stepKey,
    name,
    due_at: due,
    status,
    sequence_number: extra.seq ?? 1,
    owner_role: extra.owner_role ?? null,
    ...extra,
  };
}

function order(factoryDate: string, extra: any = {}) {
  return {
    id: 'o-1',
    order_no: 'QM-TEST-001',
    factory_date: factoryDate,
    incoterm: 'FOB',
    ...extra,
  };
}

// ──────────────────────────────────────────────────────────
// CASE 1: 正常订单
// ──────────────────────────────────────────────────────────

section('Case 1 — 正常订单（关键节点都未到期，缓冲充足）');
{
  const out = computeDeliveryConfidence({
    order: order('2026-06-30'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      ms('procurement_order_placed', '采购下单', '2026-04-15', 'done', { seq: 2 }),
      ms('production_kickoff', '大货启动', '2026-05-15', 'in_progress', { seq: 3, owner_role: 'production' }),
      ms('factory_completion', '工厂完成', '2026-06-20', 'pending', { seq: 4, owner_role: 'production' }),
      ms('booking_done', '订舱完成', '2026-06-28', 'pending', { seq: 5, owner_role: 'logistics' }),
    ],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel, 'headline=', out.explain.headline);
  assert(out.confidence >= 85, 'confidence ≥ 85', `got ${out.confidence}`);
  assert(out.riskLevel === 'green', 'riskLevel = green', `got ${out.riskLevel}`);
  assert(out.explain.headline.includes('🟢'), 'headline 含 🟢');
  assert(out.explain.next_blocker?.step_key === 'production_kickoff', 'next_blocker = production_kickoff',
    `got ${out.explain.next_blocker?.step_key}`);
  assert(out.explain.reasons.length === 0, 'reasons 为空', `got ${out.explain.reasons.length}`);
}

// ──────────────────────────────────────────────────────────
// CASE 2: 非关键节点逾期（不应大幅降分）
// ──────────────────────────────────────────────────────────

section('Case 2 — 非关键节点逾期（不应大幅降分）');
{
  const out = computeDeliveryConfidence({
    order: order('2026-06-30'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      ms('procurement_order_placed', '采购下单', '2026-04-15', 'done', { seq: 2 }),
      // 非关键节点超期 18 天
      ms('packing_method_confirmed', '包装方式确认', '2026-04-18', 'in_progress', { seq: 3 }),
      // 非关键节点超期 5 天
      ms('mid_qc_check', '中查', '2026-05-01', 'in_progress', { seq: 4 }),
      ms('production_kickoff', '大货启动', '2026-05-15', 'pending', { seq: 5 }),
      ms('factory_completion', '工厂完成', '2026-06-20', 'pending', { seq: 6 }),
      ms('booking_done', '订舱完成', '2026-06-28', 'pending', { seq: 7 }),
    ],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel,
    'reasons=', out.explain.reasons.map(r => `${r.label}(${r.delta})`));
  assert(out.confidence >= 80, '非关键节点逾期不应导致 < 80', `got ${out.confidence}`);
  assert(out.riskLevel !== 'red' && out.riskLevel !== 'orange',
    'level 不应是 red/orange', `got ${out.riskLevel}`);
  // 非关键扣分总额封顶 -10
  const totalNonCritical = out.explain.reasons
    .filter(r => r.code === 'noncritical_overdue')
    .reduce((s, r) => s + r.delta, 0);
  assert(totalNonCritical >= -10, '非关键节点扣分总额封顶 -10', `got ${totalNonCritical}`);
}

// ──────────────────────────────────────────────────────────
// CASE 3: 关键节点超期（明显降分）
// ──────────────────────────────────────────────────────────

section('Case 3 — 关键节点超期 8 天（明显降分）');
{
  const out = computeDeliveryConfidence({
    order: order('2026-06-30'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      // 关键节点超期 12 天 (今天 5-6, due 4-24)
      ms('procurement_order_placed', '采购下单', '2026-04-24', 'in_progress', { seq: 2, owner_role: 'procurement' }),
      ms('production_kickoff', '大货启动', '2026-05-15', 'pending', { seq: 3 }),
      ms('factory_completion', '工厂完成', '2026-06-20', 'pending', { seq: 4 }),
      ms('booking_done', '订舱完成', '2026-06-28', 'pending', { seq: 5 }),
    ],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel,
    'next_action=', out.explain.next_action);
  assert(out.confidence < 80 && out.confidence >= 50, 'confidence 在 50-80 之间', `got ${out.confidence}`);
  assert(['yellow', 'orange'].includes(out.riskLevel),
    'level 应为 yellow/orange', `got ${out.riskLevel}`);
  const hasCriticalReason = out.explain.reasons.some(r => r.code === 'critical_step_overdue');
  assert(hasCriticalReason, 'reasons 含 critical_step_overdue');
  assert((out.explain.next_action || '').includes('采购'), 'next_action 提到采购',
    `got "${out.explain.next_action}"`);
}

// ──────────────────────────────────────────────────────────
// CASE 4: blocked + 无延期 → 强制 red < 50
// ──────────────────────────────────────────────────────────

section('Case 4 — blocked 且无延期处理 → red 且 < 50');
{
  const out = computeDeliveryConfidence({
    order: order('2026-06-15'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      // 关键节点 blocked + 无延期申请
      ms('production_kickoff', '大货启动', '2026-05-01', 'blocked', { seq: 2, owner_role: 'production' }),
      ms('factory_completion', '工厂完成', '2026-06-05', 'pending', { seq: 3 }),
      ms('booking_done', '订舱完成', '2026-06-13', 'pending', { seq: 4 }),
    ],
    delayRequests: [],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel,
    'headline=', out.explain.headline);
  assert(out.confidence < 50, 'blocked + 无方案 → confidence < 50', `got ${out.confidence}`);
  assert(out.riskLevel === 'red', 'level = red', `got ${out.riskLevel}`);
  const hasBlockedReason = out.explain.reasons.some(r => r.code === 'critical_blocked_no_resolution');
  assert(hasBlockedReason, 'reasons 含 critical_blocked_no_resolution');
  assert((out.explain.next_action || '').includes('解除'), 'next_action 包含"解除"',
    `got "${out.explain.next_action}"`);
}

// ──────────────────────────────────────────────────────────
// CASE 5: 已批准延期 + buffer 够 → yellow，不应 red
// ──────────────────────────────────────────────────────────

section('Case 5 — 关键节点旧 due 已过，但延期已批准且新日期合理 → 不应 red');
{
  const out = computeDeliveryConfidence({
    order: order('2026-07-15'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      // 关键节点旧 due 是 4-20（超期 16 天），但 status 还是 in_progress（DB due 没改）
      ms('production_kickoff', '大货启动', '2026-04-20', 'in_progress', {
        seq: 2, owner_role: 'production', id: 'm-pk',
      }),
      ms('factory_completion', '工厂完成', '2026-07-05', 'pending', { seq: 3 }),
      ms('booking_done', '订舱完成', '2026-07-13', 'pending', { seq: 4 }),
    ],
    delayRequests: [
      // 延期已批准，新日期 5-25（在未来）
      {
        milestone_id: 'm-pk',
        status: 'approved',
        proposed_new_due_at: '2026-05-25',
      },
    ],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel);
  assert(out.confidence >= 70, '已批延期 + buffer 够 → confidence ≥ 70', `got ${out.confidence}`);
  assert(['green', 'yellow'].includes(out.riskLevel),
    'level = green/yellow', `got ${out.riskLevel}`);
  const hasCoveredReason = out.explain.reasons.some(r => r.code === 'critical_delayed_but_approved');
  assert(hasCoveredReason, 'reasons 含 critical_delayed_but_approved（小幅扣分而非大扣）');
  // 不应有 critical_step_overdue 的 -20/-30 扣分
  const hasBigCriticalDeduction = out.explain.reasons.some(
    r => r.code === 'critical_step_overdue',
  );
  assert(!hasBigCriticalDeduction, '不应有 critical_step_overdue 大扣分（已被覆盖）');
}

// ──────────────────────────────────────────────────────────
// CASE 6: 已出运 + 尾款待收
// ──────────────────────────────────────────────────────────

section('Case 6 — 已出运 + 尾款待收（切换付款视角）');
{
  const out = computeDeliveryConfidence({
    order: order('2026-04-10'), // 出厂日已过
    milestones: [
      ms('finance_approval', '财务审批', '2026-03-01', 'done', { seq: 1 }),
      ms('production_kickoff', '大货启动', '2026-03-15', 'done', { seq: 2 }),
      ms('factory_completion', '工厂完成', '2026-04-08', 'done', { seq: 3 }),
      // 关键：booking_done 已 done
      ms('booking_done', '订舱完成', '2026-04-10', 'done', { seq: 4 }),
    ],
    financials: {
      balance_status: 'pending',
      deposit_status: 'received',
    },
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel,
    'headline=', out.explain.headline,
    'next_action=', out.explain.next_action);
  assert(out.confidence >= 70, '已出运的订单 confidence 应较高', `got ${out.confidence}`);
  assert(out.explain.headline.includes('已出运'), 'headline 含"已出运"');
  assert(out.explain.next_blocker === null, '已出运订单 next_blocker = null');
  const hasBalanceReason = out.explain.reasons.some(r => r.code === 'balance_pending');
  assert(hasBalanceReason, 'reasons 含 balance_pending');
  assert((out.explain.next_action || '').includes('尾款'), 'next_action 提到尾款',
    `got "${out.explain.next_action}"`);
  // 不应被排期问题拖累
  const hasFactoryDateIssue = out.explain.reasons.some(r => r.code === 'factory_date_passed');
  assert(!hasFactoryDateIssue, '已出运订单不应再标"出厂日已过"');
}

// ──────────────────────────────────────────────────────────
// CASE 7: 出厂日已过 + 货物未出
// ──────────────────────────────────────────────────────────

section('Case 7 — 出厂日已过 10 天且货物未出 → red 严重');
{
  const out = computeDeliveryConfidence({
    order: order('2026-04-26'), // 今天 5-6，超期 10 天
    milestones: [
      ms('finance_approval', '财务审批', '2026-03-01', 'done', { seq: 1 }),
      ms('production_kickoff', '大货启动', '2026-03-15', 'done', { seq: 2 }),
      // 关键节点未完成
      ms('factory_completion', '工厂完成', '2026-04-25', 'in_progress', { seq: 3, owner_role: 'production' }),
      ms('booking_done', '订舱完成', '2026-04-26', 'pending', { seq: 4 }),
    ],
    now: NOW,
  });
  console.log('   confidence=', out.confidence, 'level=', out.riskLevel,
    'reasons=', out.explain.reasons.map(r => `${r.label}(${r.delta})`));
  assert(out.confidence < 50, 'confidence < 50', `got ${out.confidence}`);
  assert(out.riskLevel === 'red', 'level = red', `got ${out.riskLevel}`);
  const hasFactoryDate = out.explain.reasons.some(r => r.code === 'factory_date_passed');
  assert(hasFactoryDate, 'reasons 含 factory_date_passed');
}

// ──────────────────────────────────────────────────────────
// CASE 8: explain 文案语义检查
// ──────────────────────────────────────────────────────────

section('Case 8 — explain_json 文案对人类友好');
{
  const out = computeDeliveryConfidence({
    order: order('2026-05-15'),
    milestones: [
      ms('finance_approval', '财务审批', '2026-04-01', 'done', { seq: 1 }),
      ms('production_kickoff', '大货启动', '2026-04-29', 'in_progress', { seq: 2, owner_role: 'production' }),
      ms('factory_completion', '工厂完成', '2026-05-13', 'pending', { seq: 3 }),
      ms('booking_done', '订舱完成', '2026-05-14', 'pending', { seq: 4 }),
    ],
    now: NOW,
  });
  // 检查 reasons 文案不是技术 ID
  for (const r of out.explain.reasons) {
    assert(!r.label.match(/^[a-z_]+$/), `label 不是 snake_case：${r.label}`);
    assert(r.label.length >= 5, `label 至少 5 字：${r.label}`);
  }
  // headline 必须含 emoji + 百分比
  assert(/[🟢🟡🟠🔴]/.test(out.explain.headline), 'headline 有 emoji');
  assert(/\d+%/.test(out.explain.headline), 'headline 有百分比');
  // next_action 不为 null（有 blocker 时）
  assert(out.explain.next_action !== null, 'next_action 不为空');
  // computed_at 是 ISO 时间
  assert(!isNaN(new Date(out.explain.computed_at).getTime()), 'computed_at 是有效时间');
}

// ──────────────────────────────────────────────────────────
// 总结
// ──────────────────────────────────────────────────────────

console.log('\n════════════════════════════════════════');
console.log(`✅ 通过: ${pass}`);
console.log(`❌ 失败: ${fail}`);
console.log('════════════════════════════════════════');
if (fail > 0) {
  console.log('\n失败用例：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n🎉 所有测试通过');
process.exit(0);
