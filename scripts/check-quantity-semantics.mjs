#!/usr/bin/env node
/**
 * 静态闸:数量语义(2026-08-12 Quantity Semantics Hotfix,1022977 事故)。
 *
 * 铁律:`order_line_items.qty_pcs` 是**商业数量(套装单=套数)**,不是物理件数。
 *   算料 / 采购基准 / MRP / 金额 一律用 **physical = qty_pcs × set_multiplier**,
 *   且必须走 lib/domain/line-item-quantity.ts 的统一 helper。
 *
 * 本闸拦两类回潮:
 *   ① critical 路径 select 了 qty_pcs 却没带 set_multiplier(必然漏乘)
 *   ② 任何地方裸写 qty_pcs * / ÷ set_multiplier(绕过统一入口)
 *
 * 例外:白名单里的文件是**刻意按商业数量(套)**的(装箱/生产任务单表头等),
 *   或本身就是统一入口/巡检工具。新增例外必须在此写明理由。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 必须按物理件数的关键路径(算料/采购/成本/报价/MRP)
const CRITICAL = [
  'app/actions/procurement-items.ts',
  'app/actions/procurement-cost.ts',
  'app/actions/quote-baseline.ts',
  'app/actions/bom.ts',
  'lib/services/mrp.ts',
];

// 刻意按"套/商业数量"或本身是入口/工具的文件
const ALLOW_RAW = new Set([
  'lib/domain/line-item-quantity.ts',                 // 统一入口本体
  'app/admin/missing-line-items/page.tsx',            // 明细完整性巡检,需同时看两种口径
  'app/actions/packing.ts',                           // 装箱按套/按行分配,商业口径
  'app/actions/manufacturing-order.ts',               // 生产任务单表头按每色数量(套)同口径
  'app/actions/order-line-items.ts',                  // 明细读写本体
  'app/actions/trade-purchase.ts',                    // 贸易成品单,倍率恒 1
  'app/actions/analytics-detail.ts',                  // 统计口径已自带 ×mul,单独维护
]);

let fail = 0;
const warn = [];

// ① critical 路径:select 含 qty_pcs 必须同时含 set_multiplier
for (const f of CRITICAL) {
  let src = '';
  try { src = readFileSync(f, 'utf-8'); } catch { continue; }
  const selects = src.match(/\.select\('[^']*qty_pcs[^']*'\)/g) || [];
  for (const s of selects) {
    if (!s.includes('set_multiplier')) {
      console.error(`❌ ${f}\n   ${s}\n   → 关键路径 select 了 qty_pcs 却没带 set_multiplier,必然漏乘(1022977 同款事故)`);
      fail++;
    }
  }
}

// ② 全仓:裸算 qty_pcs × / ÷ set_multiplier(绕过统一入口)
let grep = '';
try {
  grep = execSync(
    `grep -rn "qty_pcs" app lib components --include='*.ts' --include='*.tsx' | grep -v node_modules || true`,
    { encoding: 'utf-8' },
  );
} catch { /* grep 无命中返回非 0 */ }

for (const line of grep.split('\n')) {
  if (!line.trim()) continue;
  const file = line.split(':')[0];
  if (ALLOW_RAW.has(file) || file.startsWith('tests/')) continue;
  // 跳过注释行(说明性文字提到公式不算违规)
  const code = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
  if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
  // 裸乘/裸除倍率
  if (/qty_pcs[^;\n]*\*[^;\n]*set_multiplier|set_multiplier[^;\n]*\*[^;\n]*qty_pcs|qty_pcs[^;\n]*\/[^;\n]*set_multiplier/.test(line)) {
    console.error(`❌ ${line.trim().slice(0, 160)}\n   → 禁止裸算套/件换算,请用 lib/domain/line-item-quantity.ts 的 helper`);
    fail++;
  }
}

// ③ 提示(不 fail):非 critical 路径读 qty_pcs 但没带倍率 —— 需人工确认是否刻意按套
const seen = new Set();
for (const line of grep.split('\n')) {
  if (!line.trim()) continue;
  const file = line.split(':')[0];
  if (ALLOW_RAW.has(file) || file.startsWith('tests/') || CRITICAL.includes(file)) continue;
  if (!/\.select\('[^']*qty_pcs/.test(line)) continue;
  if (line.includes('set_multiplier') || seen.has(file)) continue;
  seen.add(file);
  warn.push(file);
}

if (warn.length) {
  console.warn('\n⚠️  以下文件读 qty_pcs 未带 set_multiplier —— 若用于算料/金额需改物理件数,若刻意按套请加进白名单并注明理由:');
  for (const f of warn) console.warn('   · ' + f);
}

if (fail > 0) {
  console.error(`\n❌ 数量语义检查失败:${fail} 处`);
  process.exit(1);
}
console.log(`✅ 数量语义检查通过(critical 路径 ${CRITICAL.length} 个,提示 ${warn.length} 处待人工确认)`);
