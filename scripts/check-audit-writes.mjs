#!/usr/bin/env node
/**
 * R1-D 静态闸:审计写入必须走 lib/audit/write-audit-event。
 *
 * ① 核心审计表(milestone_logs/order_logs)直接 .insert( —— 新增即 fail(棘轮,存量入基线);
 * ② 新增 `actor_id:` 旧语义(order_logs 双列漂移)—— 新增即 fail;
 * 例外:lib/audit/ 本体、纯 service-role cron 文件豁免不了(审计统一层就是给它们用的,一视同仁)。
 * 重新生成基线:--update-baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASELINE_PATH = 'scripts/audit-writes-baseline.json';
const EXCLUDE = ['lib/audit/write-audit-event.ts'];

function scan() {
  const out = [];
  let hits = '';
  try {
    hits = execSync(String.raw`grep -rn "from('\(milestone_logs\|order_logs\)')" app lib --include='*.ts' --include='*.tsx'`, { encoding: 'utf-8' });
  } catch { /* none */ }
  for (const line of hits.split('\n').filter(Boolean)) {
    const [file, lineNo] = line.split(':');
    if (EXCLUDE.includes(file)) continue;
    // 只拦 insert(读时间线合法);看命中行起 300 字符
    const src = readFileSync(file, 'utf-8');
    const idx = src.split('\n').slice(0, +lineNo - 1).join('\n').length;
    const stmt = src.slice(idx, idx + 400);
    if (/\.insert\(/.test(stmt)) out.push(`${file} insert`);   // 键不含行号(编辑漂移免疫)
  }
  // actor_id 旧语义(写入侧;排除 actor_user_id 命中)
  let actorHits = '';
  try {
    actorHits = execSync(String.raw`grep -rn "actor_id:" app lib --include='*.ts' | grep -v actor_user_id | grep -v "on_behalf"`, { encoding: 'utf-8' });
  } catch { /* none */ }
  for (const line of actorHits.split('\n').filter(Boolean)) {
    const [file, lineNo] = line.split(':');
    out.push(`${file} actor_id-legacy`);
  }
  return out.sort();
}

const violations = scan();
if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify(violations, null, 2) + '\n');
  console.log(`审计基线已更新:${violations.length} 条存量`);
  process.exit(0);
}
const count = (list) => { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return m; };
const baseCounts = count((existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) : []).map((v) => v.replace(/:\d+ /, ' ')));
const nowCounts = count(violations);
const fresh = [];
for (const [k, n] of nowCounts) if (n > (baseCounts.get(k) || 0)) fresh.push(`${k} (${baseCounts.get(k) || 0}→${n})`);
if (fresh.length) {
  console.error(`❌ 新增裸审计写入/actor_id 旧语义 ${fresh.length} 处:`);
  for (const v of fresh) console.error('   ' + v);
  console.error('   → 审计一律走 lib/audit/write-audit-event 的 writeAuditEvent()');
  process.exit(1);
}
console.log(`✅ 审计写入检查通过(存量待清 ${violations.length} 处)`);
