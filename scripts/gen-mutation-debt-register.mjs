#!/usr/bin/env node
/**
 * Critical Mutation Debt Register(R1-C 遗留 65 处 direct-write 的自动分级)。
 * 与审计修复分开计数(CEO:两者可同文件顺手处理,但必须分别验收)。
 * 分级依据 = 表 + 文件语境关键词;Critical 必须在 Executive OS V1 真执行前清零。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const baseline = JSON.parse(readFileSync('scripts/critical-writes-baseline.json', 'utf-8'));
const CRIT_KEYS = /price|amount|total|quantity|lifecycle|terminat|cancel|complete|ship|payment|allow_shipment|owner_user_id|approval|special_tags|status/i;
const LOW_FILES = /agent-suggestions|notes|draft|preference|ui-|display/i;

const rows = baseline.map((entry) => {
  const [loc, op] = entry.split(' ');
  const [file, line] = loc.split(':');
  const src = readFileSync(file, 'utf-8').split('\n');
  const ctx = src.slice(Math.max(0, +line - 3), +line + 6).join('\n');
  const [table] = op.split('.');
  let tier;
  if (['order_financials', 'purchase_orders', 'order_amendments', 'pre_order_price_approvals', 'order_commissions'].includes(table)) tier = 'critical';
  else if (table === 'delay_requests') tier = CRIT_KEYS.test(ctx) ? 'critical' : 'medium';
  else if (table === 'orders') tier = LOW_FILES.test(file) ? 'low' : CRIT_KEYS.test(ctx) ? 'critical' : 'medium';
  else tier = 'medium';
  return { entry, table, tier, hint: (ctx.match(CRIT_KEYS) || [''])[0] };
});

const by = (t) => rows.filter((r) => r.tier === t);
const report = {
  generated_at: new Date().toISOString(),
  critical_count: by('critical').length,
  medium_count: by('medium').length,
  low_count: by('low').length,
  note: 'Executive OS V1 真执行前 critical_count 必须为 0;与审计债分开验收',
  critical: by('critical').map((r) => `${r.entry} [${r.hint}]`),
  medium: by('medium').map((r) => r.entry),
  low: by('low').map((r) => r.entry),
};
writeFileSync('docs/architecture/critical-mutation-debt-register.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Debt Register: critical ${report.critical_count} / medium ${report.medium_count} / low ${report.low_count}`);
