#!/usr/bin/env node
/**
 * R1-C 静态闸:critical 表的 UPDATE/DELETE 必须能看见受影响行数。
 *
 * 原则:NO DATABASE CONFIRMATION = NO SUCCESS。
 * RLS 把 UPDATE 滤成 0 行时 PostgREST **不报 error** —— 只有 .select(pk) 回带才看得见。
 * 所以对钱/交付/权限相关的表,裸 `.update()/.delete()`(链上无 .select)一律视为违规。
 *
 * 棘轮制:存量违规记录在 critical-writes-baseline.json(逐步清零,数量进 Gate Report);
 * **新增violations 直接 fail** —— 只出不进。
 * 重新生成基线:node scripts/check-critical-writes.mjs --update-baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CRITICAL_TABLES = [
  'orders', 'order_amendments', 'delay_requests', 'pre_order_price_approvals',
  'order_financials', 'purchase_orders', 'order_commissions',
];
const BASELINE_PATH = 'scripts/critical-writes-baseline.json';
const EXCLUDE = ['lib/db/safe-mutation.ts'];

const files = execSync(
  String.raw`grep -rl "\.from('\(${CRITICAL_TABLES.join('\\|')}\)')" app lib --include='*.ts' --include='*.tsx'`,
  { encoding: 'utf-8' },
).split('\n').filter(Boolean).filter((f) => !EXCLUDE.includes(f));

const tableRe = CRITICAL_TABLES.join('|');
const re = new RegExp(String.raw`\.from\(['"](${tableRe})['"]\)[^;]{0,400}?\.(update|delete)\(`, 'gs');

const violations = [];
for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  for (const m of src.matchAll(re)) {
    // 链上(命中点前后共 600 字符窗口)有 .select( → 合规;走 safeMutation 不会命中本模式
    const windowEnd = src.slice(m.index, m.index + 600);
    // 从 .update(/.delete( 之后找同语句内的 .select(
    const afterOp = windowEnd.slice(windowEnd.indexOf('.' + m[2] + '('));
    const stmt = afterOp.slice(0, afterOp.indexOf(';') === -1 ? 400 : afterOp.indexOf(';'));
    if (/\.select\(/.test(stmt)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    violations.push(`${f}:${line} ${m[1]}.${m[2]}`);
  }
}

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify(violations.sort(), null, 2) + '\n');
  console.log(`基线已更新:${violations.length} 条存量违规`);
  process.exit(0);
}

const baseline = new Set(existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) : []);
const fresh = violations.filter((v) => !baseline.has(v));
const cleared = [...baseline].filter((b) => !violations.includes(b));

if (fresh.length) {
  console.error(`❌ critical 表新增裸写 ${fresh.length} 处(UPDATE/DELETE 链上无 .select,RLS 滤 0 行时完全不可见):`);
  for (const v of fresh) console.error('   ' + v);
  console.error('   → 请改用 lib/db/safe-mutation 的 safeMutation()/safeCriticalMutation()');
  process.exit(1);
}
console.log(`✅ critical 表写入检查通过(存量待清 ${violations.length} 处${cleared.length ? `,本次已清 ${cleared.length} 处 —— 记得 --update-baseline 收紧棘轮` : ''})`);
