/**
 * Quote 子阶段1 单元测试 — Header + Line 重构
 *
 * 运行：
 *   npx tsx scripts/test-quote.ts
 *
 * 覆盖（纯函数层，无 DB/auth）：
 *   1. buildQuoteLineRow 字段映射口径 = Header 写入 = 回填 migration
 *   2. 缺省值（trim/packing/logistics=0、margin=15、currency=USD、exchange=7.2、color=null）
 *   3. 多款能力：line_no=2 独立成行（数据层支持 N 行）
 *   4. 红线：status 恒为 'draft'；行内不得出现 is_approved / approved_version / snapshot
 *
 * 注：customer_id 必填、quote_line 实际落库、孤儿清理属 server action（需 DB+auth），
 *     由代码审查 + 手动验证覆盖，不在本纯函数单测内。
 */

import { buildQuoteLineRow } from '../lib/quoter/types';
import type { QuoteInput, QuoteOutput } from '../lib/quoter/types';

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

const input: QuoteInput = {
  customer_id: 'cust-1',
  customer_name: 'ACME',
  style_no: 'ST-100',
  style_name: '女士瑜伽裤',
  garment_type: 'knit_bottom',
  subtype: 'yoga_pants',
  quantity: 1200,
  size_distribution: { M: 600, L: 600 },
  size_chart: { garment_type: 'knit_bottom', primary_size: 'M', sizes: {} },
  fabric: {
    fabric_type: '四面弹',
    composition: '88%锦纶 12%氨纶',
    width_cm: 150,
    weight_gsm: 250,
    price_per_kg: 60,
  },
  cmt_factory: 'F-1',
  cmt_complexity: 'standard',
  trim_cost_per_piece: 2,
  packing_cost_per_piece: 1,
  logistics_cost_per_piece: 0.5,
  margin_rate: 18,
  currency: 'USD',
  exchange_rate: 7.1,
};

const result: QuoteOutput = {
  fabric: {
    primary_size_kg: 0.3,
    avg_kg: 0.32,
    area_m2: 1.2,
    reasoning: '',
    factors: { base_area_m2: 1, shrinkage_pct: 3, waste_pct: 10, fabric_weight_gsm: 250 },
    confidence: 90,
    source: 'formula',
  },
  cmt: {
    total_rmb: 12,
    operations: [{ code: 'sew', name: '车缝', base_rate_rmb: 8, adjusted_rate: 8 }],
    reasoning: '',
    confidence: 85,
    source: 'rules',
  },
  costs: { fabric_rmb: 19.2, cmt_rmb: 12, trim_rmb: 2, packing_rmb: 1, logistics_rmb: 0.5, subtotal_rmb: 34.7 },
  quote_rmb_per_piece: 42.3,
  quote_currency_per_piece: 5.95,
  total_currency: 7140,
  effective_margin_pct: 18,
  overall_confidence: 88,
};

// ──────────────────────────────────────────────────────────
// 1. 字段映射口径
// ──────────────────────────────────────────────────────────

section('1. buildQuoteLineRow 字段映射口径');
const row = buildQuoteLineRow('quote-1', 1, input, result);

assert(row.quote_id === 'quote-1', 'quote_id 透传');
assert(row.line_no === 1, 'line_no = 1');
assert(row.style_no === 'ST-100', 'style_no ← input.style_no');
assert(row.style_name === '女士瑜伽裤', 'style_name ← input.style_name');
assert(row.garment_type === 'knit_bottom', 'garment_type ← input.garment_type');
assert(row.garment_subtype === 'yoga_pants', 'garment_subtype ← input.subtype');
assert(row.quantity === 1200, 'quantity ← input.quantity');
assert(JSON.stringify(row.size_distribution) === JSON.stringify({ M: 600, L: 600 }), 'size_distribution 透传');
assert(row.fabric_type === '四面弹', 'fabric_type ← input.fabric.fabric_type');
assert(row.fabric_composition === '88%锦纶 12%氨纶', 'fabric_composition ← input.fabric.composition');
assert(row.fabric_width_cm === 150, 'fabric_width_cm ← input.fabric.width_cm');
assert(row.fabric_price_per_kg === 60, 'fabric_price_per_kg ← input.fabric.price_per_kg');
assert(row.fabric_consumption_kg === 0.32, 'fabric_consumption_kg ← result.fabric.avg_kg');
assert(row.fabric_cost_per_piece === 19.2, 'fabric_cost_per_piece ← result.costs.fabric_rmb');
assert(row.cmt_factory === 'F-1', 'cmt_factory ← input.cmt_factory');
assert(Array.isArray(row.cmt_operations) && (row.cmt_operations as any[]).length === 1, 'cmt_operations ← result.cmt.operations');
assert(row.cmt_cost_per_piece === 12, 'cmt_cost_per_piece ← result.costs.cmt_rmb');
assert(row.trim_cost_per_piece === 2, 'trim_cost_per_piece ← input');
assert(row.packing_cost_per_piece === 1, 'packing_cost_per_piece ← input');
assert(row.logistics_cost_per_piece === 0.5, 'logistics_cost_per_piece ← input');
assert(row.total_cost_per_piece === 34.7, 'total_cost_per_piece ← result.costs.subtotal_rmb');
assert(row.margin_rate === 18, 'margin_rate ← input.margin_rate');
assert(row.quoted_price_per_piece === 5.95, 'quoted_price_per_piece ← result.quote_currency_per_piece');
assert(row.currency === 'USD', 'currency ← input.currency');
assert(row.exchange_rate === 7.1, 'exchange_rate ← input.exchange_rate');

// ──────────────────────────────────────────────────────────
// 2. 缺省值
// ──────────────────────────────────────────────────────────

section('2. 缺省值（最小输入）');
const minimal: QuoteInput = {
  garment_type: 'knit_top',
  quantity: 0,
  size_chart: { garment_type: 'knit_top', primary_size: 'M', sizes: {} },
  fabric: { fabric_type: '', width_cm: 0, weight_gsm: 0 },
};
const minRow = buildQuoteLineRow('quote-2', 1, minimal, result);

assert(minRow.color === null, 'color 默认 null（单款无颜色）');
assert(minRow.garment_subtype === null, 'garment_subtype 默认 null');
assert(minRow.style_no === null, 'style_no 默认 null');
assert(minRow.trim_cost_per_piece === 0, 'trim 默认 0');
assert(minRow.packing_cost_per_piece === 0, 'packing 默认 0');
assert(minRow.logistics_cost_per_piece === 0, 'logistics 默认 0');
assert(minRow.margin_rate === 15.0, 'margin 默认 15');
assert(minRow.currency === 'USD', 'currency 默认 USD');
assert(minRow.exchange_rate === 7.2, 'exchange_rate 默认 7.2');

// ──────────────────────────────────────────────────────────
// 3. 多款能力（数据层支持 N 行）
// ──────────────────────────────────────────────────────────

section('3. 多款能力 — line_no=2 独立成行');
const input2: QuoteInput = { ...input, style_no: 'ST-200', style_name: '男士卫衣' };
const row2 = buildQuoteLineRow('quote-1', 2, input2, result);

assert(row2.line_no === 2, '第二行 line_no = 2');
assert(row2.quote_id === 'quote-1', '同一 Header 下的第二行');
assert(row2.style_no === 'ST-200', '第二行款号独立');
assert(row.style_no === 'ST-100', '第一行不被第二行污染');

// ──────────────────────────────────────────────────────────
// 4. 红线
// ──────────────────────────────────────────────────────────

section('4. 红线断言');
assert(row.status === 'draft', 'status 恒为 draft');
assert(minRow.status === 'draft', '最小输入 status 也为 draft');
assert(!('is_approved' in row), '行内不含 is_approved（snapshot 属子阶段2）');
assert(!('approved_version' in row), '行内不含 approved_version');
assert(!('snapshot' in row), '行内不含 snapshot');
assert(!('version' in row), '行内不含 version（Version 属子阶段2）');

// ──────────────────────────────────────────────────────────
// 结果
// ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('✅ 全部通过');
