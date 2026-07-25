/**
 * K1 单元测试 — Material Decision 触发策略 + Outcome 自动信号
 *
 * 运行：npx tsx scripts/test-material-decisions.ts
 *
 * 覆盖：
 *   1. 非模板/未提交行 → 一律普通编辑（不捕获）
 *   2. 模板行单耗 +6.7%(>5%) → 关键决策 consumption_change
 *   3. 模板行单耗 +1.7%(<5%) → 不捕获
 *   4. 模板行换料 → material_swap
 *   5. 已提交行微调(阈值=0) → 捕获
 *   6. 删除模板行 → line_delete；删除 manual 草稿行 → 不捕获
 *   7. Outcome：补料 → too_low；超买 → too_high；都无 → correct
 */

import { classifyBomEdit, classifyBomDelete, toSnapshot, toContext } from '../lib/knowledge/policy';
import { computeOutcomeSignals, suggestOutcome } from '../lib/knowledge/outcome';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(name: string) { console.log(`\n▶ ${name}`); }

const TEMPLATE = { product_bom_template_id: 't-1', submit_status: 'draft', material_master_id: 'm-1' };
const MANUAL = { product_bom_template_id: null, submit_status: 'draft', source: 'manual' };
const SUBMITTED = { product_bom_template_id: null, submit_status: 'submitted', material_master_id: 'm-1' };

// ──────────────────────────────────────────────────────────
section('1. 非模板 + 未提交 → 普通编辑');
{
  const before = toSnapshot({ ...MANUAL, qty_per_piece: 1.20, material_name: '棉布' });
  const after = toSnapshot({ ...MANUAL, qty_per_piece: 1.80, material_name: '棉布' }); // +50%
  const r = classifyBomEdit(before, after, toContext(MANUAL));
  assert(r.isKeyDecision === false, '大改单耗但还在搭初始BOM → 不捕获', JSON.stringify(r));
}

section('2. 模板行单耗 1.20→1.28 (+6.7% > 5%) → consumption_change');
{
  const base = { ...TEMPLATE, material_name: '主面料' };
  const before = toSnapshot({ ...base, qty_per_piece: 1.20 });
  const after = toSnapshot({ ...base, qty_per_piece: 1.28 });
  const r = classifyBomEdit(before, after, toContext(base));
  assert(r.isKeyDecision === true, '超阈值 → 关键决策', JSON.stringify(r));
  assert(r.decisionType === 'consumption_change', 'type=consumption_change', r.decisionType || 'null');
}

section('3. 模板行单耗 1.20→1.22 (+1.7% < 5%) → 不捕获');
{
  const base = { ...TEMPLATE, material_name: '主面料' };
  const before = toSnapshot({ ...base, qty_per_piece: 1.20 });
  const after = toSnapshot({ ...base, qty_per_piece: 1.22 });
  const r = classifyBomEdit(before, after, toContext(base));
  assert(r.isKeyDecision === false, '阈值内微调 → 不打扰', JSON.stringify(r));
}

section('4. 模板行换料 (material_master_id 变) → material_swap');
{
  const before = toSnapshot({ ...TEMPLATE, qty_per_piece: 1.2, material_master_id: 'm-1', material_name: '料A' });
  const after = toSnapshot({ ...TEMPLATE, qty_per_piece: 1.2, material_master_id: 'm-2', material_name: '料B' });
  const r = classifyBomEdit(before, after, toContext(TEMPLATE));
  assert(r.isKeyDecision === true && r.decisionType === 'material_swap', '换料 → material_swap', JSON.stringify(r));
}

section('5. 已提交行单耗微调 1.20→1.21 (阈值=0) → 捕获');
{
  const before = toSnapshot({ ...SUBMITTED, qty_per_piece: 1.20, material_name: '主面料' });
  const after = toSnapshot({ ...SUBMITTED, qty_per_piece: 1.21, material_name: '主面料' });
  const r = classifyBomEdit(before, after, toContext(SUBMITTED));
  assert(r.isKeyDecision === true && r.decisionType === 'consumption_change', '提交后任何变化都记', JSON.stringify(r));
}

section('6. 删除');
{
  const rTpl = classifyBomDelete(toContext(TEMPLATE));
  assert(rTpl.isKeyDecision === true && rTpl.decisionType === 'line_delete', '删模板行 → line_delete', JSON.stringify(rTpl));
  const rManual = classifyBomDelete(toContext(MANUAL));
  assert(rManual.isKeyDecision === false, '删 manual 草稿行 → 不捕获', JSON.stringify(rManual));
}

section('7. Outcome 自动信号');
{
  const supp = computeOutcomeSignals({ procurementItems: [{ is_supplement: true, supplement_base_item_id: 'p-1', supplement_reason: '面料短缺' }] });
  assert(supp.is_supplement === true, '补料 → is_supplement=true');
  assert(suggestOutcome(supp) === 'too_low_caused_supplement', '建议 too_low_caused_supplement', suggestOutcome(supp) || 'null');

  const over = computeOutcomeSignals({ procurementItems: [{ is_supplement: false, suggested_purchase_qty: 100, final_purchase_qty: 130 }] });
  assert(suggestOutcome(over) === 'too_high_caused_waste', '超买 → too_high_caused_waste', suggestOutcome(over) || 'null');

  const ok = computeOutcomeSignals({ procurementItems: [{ is_supplement: false, suggested_purchase_qty: 100, final_purchase_qty: 100 }] });
  assert(suggestOutcome(ok) === 'correct', '无补料无超买 → correct(待人确认)', suggestOutcome(ok) || 'null');

  const cv = computeOutcomeSignals({ costPlanned: 1000, costActual: 1200 });
  assert(Math.abs((cv.cost_variance_pct ?? 0) - 0.2) < 1e-9, '成本差 +20%', String(cv.cost_variance_pct));
}

// ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) { console.log('失败用例：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
