/**
 * 表审计 v3.1 — 用 service_role 只读查询每张表的真实数据
 *
 * 目标：补全 docs/db-table-usage-audit.md，从静态分析升级到生产实际数据
 *
 * 查询：
 *   1. 每张表行数
 *   2. created_at / updated_at 最大值（最近活跃时间）
 *   3. 最近 30 天写入数
 *   4. 外键依赖（哪些表 reference 它）
 *
 * 用法：
 *   npx tsx scripts/audit-tables-v31.ts
 *
 * 输出：JSON + 人类可读 markdown 表格，复制到 db-table-usage-audit.md
 *
 * ⚠️ 仅 SELECT，绝不 INSERT/UPDATE/DELETE
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// 加载 .env.local
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// migrations 中定义的全部 73 张表
const TABLES = [
  'agent_actions','agent_batch_jobs','ai_collection_log','ai_context_cache','ai_knowledge_base',
  'ai_learning_log','ai_skill_actions','ai_skill_circuit_state','ai_skill_runs','attachments',
  'cancel_requests','company_profile','company_settings','compliance_findings','cost_reconciliations',
  'customer_analytics','customer_email_domains','customer_memory','customer_rhythm','customers',
  'daily_briefings','daily_tasks','delay_requests','document_extractions','email_order_diffs',
  'email_process_log','exceptions','factories','factory_analytics','issue_slip_lines',
  'issue_slips','mail_inbox','materials_bom','milestone_logs','milestones',
  'notifications','order_amendments','order_attachments','order_commissions','order_confirmations',
  'order_cost_baseline','order_financials','order_logs','order_model_analytics','order_notes_log',
  'order_retrospectives','order_root_causes','order_sequences','order_templates','orders',
  'outsource_jobs','packing_list_lines','packing_lists','pre_order_price_approvals','procurement_line_items',
  'procurement_shared_sheets','procurement_sheet_items','procurement_tracking','production_reports','profiles',
  'profit_snapshots','qc_inspections','quoter_cmt_operations','quoter_cmt_rates','quoter_cmt_training_samples',
  'quoter_fabric_records','quoter_quotes','quoter_training_feedback','shipment_batches','shipment_confirmations',
  'system_alerts','system_health_reports','system_kv','user_memos',
  // 历史归档表（v2 已 RENAME）
  'order_model_analytics_archived_20260427',
];

const NOW_MS = Date.now();
const THIRTY_DAYS_AGO = new Date(NOW_MS - 30 * 86400_000).toISOString();

interface TableStat {
  table: string;
  exists: boolean;
  rowCount: number | null;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  maxCreatedAt: string | null;
  maxUpdatedAt: string | null;
  recent30dWrites: number | null;
  error: string | null;
}

async function auditTable(table: string): Promise<TableStat> {
  const result: TableStat = {
    table,
    exists: false,
    rowCount: null,
    hasCreatedAt: false,
    hasUpdatedAt: false,
    maxCreatedAt: null,
    maxUpdatedAt: null,
    recent30dWrites: null,
    error: null,
  };

  // 1. 行数 + 是否存在
  const { count, error: countErr } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (countErr) {
    result.error = countErr.message;
    return result;
  }
  result.exists = true;
  result.rowCount = count;

  if (!count || count === 0) return result;

  // 2. 探测 created_at（拿一行试试）
  const { data: probe, error: probeErr } = await supabase
    .from(table)
    .select('*')
    .limit(1);
  if (probeErr || !probe || probe.length === 0) return result;

  const sampleRow: any = probe[0];
  result.hasCreatedAt = 'created_at' in sampleRow;
  result.hasUpdatedAt = 'updated_at' in sampleRow;

  // 3. max(created_at)
  if (result.hasCreatedAt) {
    const { data: maxC } = await supabase
      .from(table)
      .select('created_at')
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (maxC && maxC.length > 0 && (maxC[0] as any).created_at) {
      result.maxCreatedAt = (maxC[0] as any).created_at;
    }

    // 最近 30 天写入数
    const { count: recentCount } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .gte('created_at', THIRTY_DAYS_AGO);
    result.recent30dWrites = recentCount;
  }

  // 4. max(updated_at)
  if (result.hasUpdatedAt) {
    const { data: maxU } = await supabase
      .from(table)
      .select('updated_at')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (maxU && maxU.length > 0 && (maxU[0] as any).updated_at) {
      result.maxUpdatedAt = (maxU[0] as any).updated_at;
    }
  }

  return result;
}

async function main() {
  console.log('🔍 表审计 v3.1 启动...\n');
  console.log(`扫描 ${TABLES.length} 张表 / 30天阈值=${THIRTY_DAYS_AGO}\n`);

  const stats: TableStat[] = [];
  for (const t of TABLES) {
    process.stdout.write(`  ${t.padEnd(40)}`);
    try {
      const s = await auditTable(t);
      stats.push(s);
      if (!s.exists) {
        console.log(`❌ 不存在 (${s.error?.slice(0, 60)})`);
      } else if (s.rowCount === 0) {
        console.log(`☐  0 rows`);
      } else {
        const last = s.maxCreatedAt || s.maxUpdatedAt;
        const recent = s.recent30dWrites !== null ? `+${s.recent30dWrites} 30d` : '';
        console.log(`✓ ${String(s.rowCount).padStart(6)} rows ${recent.padEnd(10)} ${last ? 'last=' + last.slice(0, 10) : ''}`);
      }
    } catch (e: any) {
      console.log(`💥 异常: ${e?.message?.slice(0, 60)}`);
      stats.push({ table: t, exists: false, rowCount: null, hasCreatedAt: false, hasUpdatedAt: false, maxCreatedAt: null, maxUpdatedAt: null, recent30dWrites: null, error: e?.message || 'unknown' });
    }
  }

  // 5. 关系查询：customer_memory / customer_rhythm / customers
  console.log('\n📊 关键关系数据：\n');

  const { count: cmCount } = await supabase.from('customer_memory').select('*', { count: 'exact', head: true });
  const { count: crCount } = await supabase.from('customer_rhythm').select('*', { count: 'exact', head: true });
  const { count: csCount } = await supabase.from('customers').select('*', { count: 'exact', head: true });
  console.log(`  customer_memory: ${cmCount} 条事件`);
  console.log(`  customer_rhythm: ${crCount} 条节奏记录`);
  console.log(`  customers: ${csCount} 条客户主档`);

  const { count: qqCount } = await supabase.from('quoter_quotes').select('*', { count: 'exact', head: true });
  const { count: ofCount } = await supabase.from('order_financials').select('*', { count: 'exact', head: true });
  const { count: psCount } = await supabase.from('profit_snapshots').select('*', { count: 'exact', head: true });
  console.log(`\n  quoter_quotes: ${qqCount}`);
  console.log(`  order_financials: ${ofCount}`);
  console.log(`  profit_snapshots: ${psCount}  ← 关键：是否真为 0?`);

  // 6. 输出 JSON 文件 + Markdown
  const fs = await import('fs/promises');
  await fs.writeFile(
    resolve(process.cwd(), 'tmp-audit-v31.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), thirtyDayCutoff: THIRTY_DAYS_AGO, stats }, null, 2),
  );
  console.log('\n✅ JSON 已写到 tmp-audit-v31.json');

  // 简易 markdown 表格输出
  console.log('\n--- Markdown 表格（粘到 audit doc）---\n');
  console.log('| 表 | 状态 | 行数 | 最近写入 | 30天写入 |');
  console.log('|---|---|---|---|---|');
  for (const s of stats.sort((a, b) => (b.rowCount || -1) - (a.rowCount || -1))) {
    const status = !s.exists ? '❌不存在' : s.rowCount === 0 ? '☐空' : '✓有数据';
    const last = s.maxCreatedAt || s.maxUpdatedAt || '-';
    const recent = s.recent30dWrites !== null ? String(s.recent30dWrites) : '-';
    console.log(`| ${s.table} | ${status} | ${s.rowCount ?? '-'} | ${last.slice(0, 10)} | ${recent} |`);
  }
}

main().catch(e => {
  console.error('💥 审计失败:', e);
  process.exit(1);
});
