#!/usr/bin/env node
/**
 * R1-E 静态闸(棘轮,键=文件+类别,行号免疫):
 * ① truth:管理数字路径(CEO/analytics/评分/财务KPI)出现"疑似全量 .select()"
 *    (链上无 limit/range/head-count/single/maybeSingle 且不在 fetchAllPages 回调里)→ 新增即 fail
 * ② role:权限场景新代码直接 `profile.role ===` / `.role === '`(绕过 canonicalRoles)→ 新增即 fail
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASELINE = 'scripts/truth-roles-baseline.json';
const TRUTH_PATHS = ['app/ceo', 'app/analytics', 'app/actions/analytics.ts', 'app/actions/execution-analytics.ts', 'app/admin/agent', 'app/actions/ai-knowledge.ts', 'app/actions/cost-control.ts'];

function scan() {
  const out = [];
  for (const path of TRUTH_PATHS) {
    let hits = '';
    try { hits = execSync(`grep -rn "\\.select(" ${path} --include='*.ts' --include='*.tsx' 2>/dev/null`, { encoding: 'utf-8' }); } catch { continue; }
    for (const line of hits.split('\n').filter(Boolean)) {
      const [file, lineNo] = line.split(':');
      const src = readFileSync(file, 'utf-8');
      const lines = src.split('\n');
      const stmt = lines.slice(+lineNo - 2, +lineNo + 6).join('\n');
      if (/count:\s*'exact'|\.limit\(|\.range\(|\.single\(|\.maybeSingle\(|fetchAllPages|head:\s*true/.test(stmt)) continue;
      out.push(`${file} truth-unbounded-select`);
    }
  }
  let roleHits = '';
  try { roleHits = execSync(String.raw`grep -rn "\.role === '\|profile\.role ===" app lib --include='*.ts' --include='*.tsx' | grep -viE "roles|canonicalRoles"`, { encoding: 'utf-8' }); } catch { /* none */ }
  for (const line of roleHits.split('\n').filter(Boolean)) {
    out.push(`${line.split(':')[0]} role-single-column`);
  }
  return out.sort();
}

const violations = scan();
if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE, JSON.stringify(violations, null, 2) + '\n');
  console.log(`真相/角色基线已更新:${violations.length} 条存量`);
  process.exit(0);
}
const count = (l) => { const m = new Map(); for (const v of l) m.set(v, (m.get(v) || 0) + 1); return m; };
const base = count(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf-8')) : []);
const now = count(violations);
const fresh = [];
for (const [k, n] of now) if (n > (base.get(k) || 0)) fresh.push(`${k} (${base.get(k) || 0}→${n})`);
if (fresh.length) {
  console.error('❌ 新增「1000行假全量」或「单列 role 权限判断」:');
  for (const v of fresh) console.error('   ' + v);
  console.error('   → 全量走 fetchAllPages/聚合计数;角色判断走 canonicalRoles/hasRoleInGroup');
  process.exit(1);
}
console.log(`✅ 真相/角色检查通过(存量待清 ${violations.length} 处)`);
