#!/usr/bin/env node
/**
 * 静态闸:数据访问分层 —— 业务层不许**新增**裸 `.from('table')`。
 *
 * 为什么:全站 2600+ 处直连表,同一张表的读写口径散落在 288 个文件里。
 * 真相分叉(头↔明细)、RLS 静默滤 0 行、审计/通知绕过统一入口,
 * 根因都是同一个:**没有数据访问层,谁都能直接摸表**。
 *
 * 棘轮制(只出不进):
 *   ① 存量直连 → 进 scripts/data-access-baseline.json,允许存在,逐步清零;
 *   ② 新增直连 → 直接 fail;
 *   ③ 允许直连的层 = repository / adapter / migration / 明确白名单的 infra(见 ALLOWED_LAYERS)。
 *
 * 业务层要访问数据 → 去 lib/repositories/ 建/用 repo,别在 action 里现摸表。
 *
 * 重新生成基线:node scripts/check-data-access-layer.mjs --update-baseline
 *   基线**只许缩不许涨**;确实要涨(大规模搬迁)必须显式加 --allow-growth。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BASELINE_PATH = 'scripts/data-access-baseline.json';
const SCAN_ROOTS = ['app', 'lib', 'components'];

/**
 * 允许直连表的层(不进基线、不算债)。
 * 只放"职责就是数据访问"的层 —— service/domain/agent 不在此列,它们的直连是债。
 */
const ALLOWED_LAYERS = [
  'lib/repositories/',          // repository —— 数据访问层本体
  'lib/adapters/',              // adapter —— 外部系统适配(目前为空,预留)
  'lib/db/',                    // infra:safe-mutation / truth-query
  'lib/supabase/',              // infra:客户端工厂
  'lib/audit/write-audit-event.ts',  // infra:审计统一入口(自带 lint:audit 闸)
  'lib/utils/notifications.ts',      // infra:通知统一入口(自带 lint:notif 闸)
];
// 注:supabase/migrations/**(SQL)与 scripts/**(回填/运维一次性脚本)本就不在扫描根内 —— 与其它闸口径一致。

/** 这些 receiver 的 .from( 是 JS 内置/存储桶,不是表访问 */
const NON_TABLE_RECEIVERS = new Set([
  'Array', 'Buffer', 'Object', 'Date', 'String', 'Number', 'Set', 'Map', 'WeakMap',
  'Blob', 'ArrayBuffer', 'BigInt', 'Promise',
  'storage',   // supabase.storage.from('bucket') —— 存储桶不是表
]);

const isAllowed = (f) => ALLOWED_LAYERS.some((p) => f === p || f.startsWith(p));
const isScannable = (f) =>
  /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__tests__/') && !f.includes('.d.ts');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(relative(process.cwd(), p));
  }
  return out;
}

// receiver.from(  —— 表名取字面量;动态表名(变量)记为 <dynamic>,同样算直连
const RE = /(?<![\w$])([A-Za-z_$][\w$]*)\.from\(\s*(?:['"]([a-z0-9_]+)['"])?/g;

function scan() {
  const counts = new Map();
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      if (!isScannable(file) || isAllowed(file)) continue;
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(RE)) {
        const [, receiver, table] = m;
        if (NON_TABLE_RECEIVERS.has(receiver) || /Array$/.test(receiver)) continue;
        const key = `${file} ${table || '<dynamic>'}`;   // 键不含行号 —— 编辑漂移免疫
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

const now = scan();
const nowTotal = [...now.values()].reduce((a, b) => a + b, 0);

const hasBaseline = existsSync(BASELINE_PATH);
const baseRaw = hasBaseline ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) : { entries: {} };
const baseEntries = baseRaw.entries || {};
const baseTotal = Object.values(baseEntries).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update-baseline')) {
  // 首次落基线(文件不存在)是建闸,不受"只许缩"约束
  if (hasBaseline && nowTotal > baseTotal && !process.argv.includes('--allow-growth')) {
    console.error(`❌ 拒绝写基线:直连数从 ${baseTotal} 涨到 ${nowTotal}(+${nowTotal - baseTotal})。`);
    console.error('   基线是用来清零的,不是用来给新债背书的。');
    console.error('   → 新增的直连请改走 lib/repositories/;确属大规模搬迁再加 --allow-growth。');
    process.exit(1);
  }
  const entries = Object.fromEntries([...now.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(BASELINE_PATH, JSON.stringify({
    _note: '数据访问分层棘轮基线。键=文件+表,值=该文件直连该表的次数。只许缩不许涨。',
    total: nowTotal,
    entries,
  }, null, 2) + '\n');
  console.log(`数据访问基线已更新:${Object.keys(entries).length} 个文件·表,共 ${nowTotal} 处直连`);
  process.exit(0);
}

const fresh = [];
for (const [k, n] of now) {
  const was = baseEntries[k] || 0;
  if (n > was) fresh.push(`${k} (${was}→${n})`);
}

if (fresh.length) {
  console.error(`❌ 新增裸 .from() 直连 ${fresh.length} 处(业务层不许直接摸表):`);
  for (const v of fresh.sort()) console.error('   ' + v);
  console.error('   → 允许直连的层:' + ALLOWED_LAYERS.join(' / '));
  console.error('   → 业务层请去 lib/repositories/ 建/用 repo 收口读写;');
  console.error('   → 确需新增 infra 白名单,改 ALLOWED_LAYERS 并在 PR 里说明理由(别偷偷 --update-baseline)。');
  process.exit(1);
}

const cleared = baseTotal - nowTotal;
console.log(
  `✅ 数据访问分层检查通过(存量直连 ${nowTotal} 处 / ${now.size} 个文件·表` +
  `${cleared > 0 ? `,较基线净清 ${cleared} 处 —— 记得 --update-baseline 收紧棘轮` : ''})`,
);
