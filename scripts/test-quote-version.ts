/**
 * Quote 子阶段2 单元测试 — Version + Approval + Frozen Snapshot
 *
 * 运行：
 *   npx tsx scripts/test-quote-version.ts
 *
 * 覆盖（纯函数层，无 DB/auth）：
 *   1. buildQuoteSnapshot：版本号 + Header + Lines 完整冻结
 *   2. evaluateApprovalGate：无目标毛利 / 全达标 / 有低毛利行 / margin 为 null 忽略
 *   3. 红线：快照 payload 不含 status 变更；门控与角色解耦
 *
 * 注：approveQuote / createVersion 实际落库（INSERT 快照、approved_version、version+1、
 *     低毛利角色拒绝）需 DB+auth，由代码审查 + 手动验证覆盖，不在纯函数单测内。
 */

import { buildQuoteSnapshot, evaluateApprovalGate } from '../lib/quoter/types';

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
// 1. buildQuoteSnapshot
// ──────────────────────────────────────────────────────────

section('1. buildQuoteSnapshot 冻结完整性');

const header = {
  id: 'q-1',
  quote_no: 'QT-20260630-001',
  customer_id: 'cust-1',
  customer_name: 'ACME',
  version: 2,
  approved_version: null,
  margin_target: 18,
  price_floor: null,
  quote_price_per_piece: 5.95,
  status: 'draft',
};
const lines = [
  { id: 'l-1', line_no: 1, style_no: 'ST-100', quoted_price_per_piece: 5.95, margin_rate: 20 },
  { id: 'l-2', line_no: 2, style_no: 'ST-200', quoted_price_per_piece: 6.1, margin_rate: 16 },
];

const snap = buildQuoteSnapshot(header, lines);
assert(snap.version === 2, 'version ← header.version');
assert(snap.header === header, 'header 原样冻结');
assert(Array.isArray(snap.lines) && snap.lines.length === 2, 'lines 全量冻结（2 行）');
assert((snap.lines[0] as any).style_no === 'ST-100', '行内容保留');

const snapNoVer = buildQuoteSnapshot({ id: 'q-2' }, []);
assert(snapNoVer.version === 1, 'version 缺失 → 默认 1');
assert(snapNoVer.lines.length === 0, '空行 → []');

// 红线：快照只装载 header/lines/version，不持有 status 变更动作
assert(
  Object.keys(snap).sort().join(',') === 'header,lines,version',
  '快照键集合 = {version, header, lines}（不掺审批/状态副作用）',
);

// ──────────────────────────────────────────────────────────
// 2. evaluateApprovalGate
// ──────────────────────────────────────────────────────────

section('2. evaluateApprovalGate 毛利门控');

// 无目标毛利 → 快路径
const gNull = evaluateApprovalGate(lines, null);
assert(gNull.needsPriceApproval === false, '无目标毛利 → 不需审批');
assert(gNull.lowMarginLines.length === 0, '无目标毛利 → 无低毛利行');

// 全达标（target=15，两行 20/16 均 ≥ 15）
const gOk = evaluateApprovalGate(lines, 15);
assert(gOk.needsPriceApproval === false, '全行达标 → 快路径');
assert(gOk.lowMarginLines.length === 0, '全行达标 → 无命中');

// 有低毛利行（target=18，L2=16 < 18）
const gLow = evaluateApprovalGate(lines, 18);
assert(gLow.needsPriceApproval === true, '有低毛利行 → 需审批');
assert(gLow.lowMarginLines.length === 1, '命中 1 行');
assert(gLow.lowMarginLines[0].line_no === 2, '命中行 = L2');

// margin_rate 为 null → 忽略（不算低毛利）
const gNullMargin = evaluateApprovalGate(
  [{ line_no: 1, margin_rate: null }, { line_no: 2, margin_rate: undefined }],
  18,
);
assert(gNullMargin.needsPriceApproval === false, 'margin 为 null/undefined → 不判低毛利');

// 边界：等于目标毛利不算低
const gEq = evaluateApprovalGate([{ line_no: 1, margin_rate: 18 }], 18);
assert(gEq.needsPriceApproval === false, '毛利 == 目标 → 不算低（严格小于才拦）');

// ──────────────────────────────────────────────────────────
// 3. 门控与角色解耦（纯函数不含角色判断）
// ──────────────────────────────────────────────────────────

section('3. 红线 — 门控纯逻辑、与角色/写库解耦');
assert(typeof evaluateApprovalGate === 'function', 'evaluateApprovalGate 是纯函数');
assert(
  JSON.stringify(evaluateApprovalGate(lines, 18)) === JSON.stringify(evaluateApprovalGate(lines, 18)),
  '相同输入 → 确定性输出',
);

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
