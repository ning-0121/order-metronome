/**
 * Day 7 — 一次性 backfill 脚本 + 分布报告
 *
 * 目的：
 *   为所有 active 订单初始化 runtime_orders（首次写入 explain_json），
 *   并产出分布报告，判断算法是否可信。
 *
 * 严格约束：
 *   - 不改 UI / 算法 / 钩子
 *   - 不动 Vercel flag（脚本内 process.env 仅本进程生效）
 *   - 不影响主链路
 *
 * 运行：
 *   npx tsx --env-file=.env.local scripts/backfill-runtime-confidence.ts
 *
 * 可选参数：
 *   --limit=50       只处理前 50 单（小流量验证用）
 *   --dry-run        只读取订单列表，不真写库
 *
 * 输出：
 *   控制台彩色报告 + JSON 文件 docs/runtime-backfill-report-YYYY-MM-DD.json
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { recomputeDeliveryConfidence } from '../app/actions/runtime-confidence';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 强制本进程开启投影；不影响 Vercel 环境
process.env.RUNTIME_CONFIDENCE_ENGINE = 'admin';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}
const sys = createSupabaseClient(url, key);

// ─────────────────────────────────────────────────────────────
// CLI 参数
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const dryRun = args.includes('--dry-run');
const throttleMs = 75; // 每单间隔

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

interface BackfillRow {
  order_id: string;
  order_no: string;
  customer_name: string | null;
  ok: boolean;
  skipped?: boolean;
  confidence?: number;
  riskLevel?: string;
  headline?: string;
  error?: string;
}

async function main() {
  const startTs = Date.now();
  console.log('════════════════════════════════════════');
  console.log('Runtime Confidence Backfill (Day 7)');
  console.log(`模式: ${dryRun ? '🟡 DRY-RUN (不写库)' : '🟢 真实回填'}`);
  if (limit) console.log(`限制: 前 ${limit} 单`);
  console.log('════════════════════════════════════════\n');

  // 1. 拉所有 active 订单
  let q = (sys.from('orders') as any)
    .select('id, order_no, customer_name, lifecycle_status, created_at')
    .not('lifecycle_status', 'in', '("cancelled","已取消","completed","已完成")')
    .order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);

  const { data: orders, error: listErr } = await q;
  if (listErr) {
    console.error('❌ 拉订单失败:', listErr.message);
    process.exit(1);
  }
  if (!orders || orders.length === 0) {
    console.log('⚠️ 没有 active 订单');
    process.exit(0);
  }

  console.log(`📦 待处理订单: ${orders.length}\n`);

  if (dryRun) {
    console.log('DRY-RUN: 不会真调 recompute，只展示订单清单');
    orders.slice(0, 10).forEach((o: any, i: number) => {
      console.log(`  ${i + 1}. ${o.order_no} (${o.customer_name})`);
    });
    if (orders.length > 10) console.log(`  ... 还有 ${orders.length - 10} 单`);
    process.exit(0);
  }

  // 2. 串行 trigger
  const rows: BackfillRow[] = [];
  let lastLogAt = Date.now();
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    let row: BackfillRow = {
      order_id: o.id,
      order_no: o.order_no,
      customer_name: o.customer_name,
      ok: false,
    };
    try {
      const r = await recomputeDeliveryConfidence(o.id, {
        type: 'external_signal',
        source: 'backfill',
        severity: 'info',
        payload: { backfill_at: new Date().toISOString() },
      });
      row.ok = r.ok;
      row.skipped = r.skipped;
      if (r.data) {
        row.confidence = r.data.confidence;
        row.riskLevel = r.data.riskLevel;
        row.headline = r.data.explainHeadline;
      }
      if (r.error) row.error = r.error;
    } catch (e: any) {
      row.error = 'exception: ' + (e?.message || 'unknown');
    }
    rows.push(row);

    // 进度日志：每 5s 或每 20 单打印一次
    if (Date.now() - lastLogAt > 5000 || (i + 1) % 20 === 0 || i === orders.length - 1) {
      const okN = rows.filter(r => r.ok && !r.skipped).length;
      const failN = rows.filter(r => !r.ok).length;
      console.log(`  [${i + 1}/${orders.length}] ok=${okN} fail=${failN}  最近: ${o.order_no}`);
      lastLogAt = Date.now();
    }

    if (i < orders.length - 1) await sleep(throttleMs);
  }

  // 3. 拉回 runtime_orders 完整数据（含 explain_json）做分析
  const okIds = rows.filter(r => r.ok && !r.skipped).map(r => r.order_id);
  let runtimeRows: any[] = [];
  if (okIds.length > 0) {
    // 分批拉避免超长 IN 列表
    for (let i = 0; i < okIds.length; i += 200) {
      const batch = okIds.slice(i, i + 200);
      const { data } = await (sys.from('runtime_orders') as any)
        .select('order_id, delivery_confidence, risk_level, predicted_finish_date, buffer_days, explain_json')
        .in('order_id', batch);
      if (data) runtimeRows.push(...data);
    }
  }

  // 4. 生成报告
  const report = buildReport(rows, runtimeRows, startTs);
  printReport(report);
  saveReport(report);

  // 5. 评估闸门：red > 30% 或 (orange+red) > 50% → 警告，不要进 Day 8/9
  const verdict = assessVerdict(report);
  console.log('\n════════════════════════════════════════');
  console.log(verdict.message);
  console.log('════════════════════════════════════════');
  process.exit(verdict.exitCode);
}

// ─────────────────────────────────────────────────────────────
// 报告构建
// ─────────────────────────────────────────────────────────────

interface Report {
  ranAt: string;
  durationSec: number;
  totals: { total: number; ok: number; failed: number; skipped: number };
  distribution: Record<string, { count: number; pct: string }>;
  confidence: { avg: number; median: number; min: number; max: number };
  topRed: Array<{ order_no: string; customer_name: string | null; confidence: number; topReason?: string }>;
  topReasonCodes: Array<{ code: string; count: number }>;
  failedOrders: Array<{ order_no: string; error: string }>;
}

function buildReport(rows: BackfillRow[], runtimeRows: any[], startTs: number): Report {
  const total = rows.length;
  const ok = rows.filter(r => r.ok && !r.skipped).length;
  const skipped = rows.filter(r => r.skipped).length;
  const failed = rows.filter(r => !r.ok).length;

  const dist: Record<string, number> = { green: 0, yellow: 0, orange: 0, red: 0, gray: 0 };
  for (const r of rows) {
    if (r.ok && r.riskLevel) dist[r.riskLevel] = (dist[r.riskLevel] || 0) + 1;
  }
  const distribution: Record<string, { count: number; pct: string }> = {};
  for (const k of ['green', 'yellow', 'orange', 'red', 'gray']) {
    distribution[k] = { count: dist[k] || 0, pct: pct(dist[k] || 0, ok) };
  }

  const confs = rows.filter(r => typeof r.confidence === 'number').map(r => r.confidence!);
  const confidence = {
    avg: avg(confs),
    median: median(confs),
    min: confs.length ? Math.min(...confs) : 0,
    max: confs.length ? Math.max(...confs) : 0,
  };

  // Top 10 red 订单 + 核心原因
  const explainByOrder = new Map<string, any>();
  for (const rr of runtimeRows) explainByOrder.set(rr.order_id, rr);

  const reds = rows
    .filter(r => r.riskLevel === 'red')
    .sort((a, b) => (a.confidence ?? 100) - (b.confidence ?? 100))
    .slice(0, 10);
  const topRed = reds.map(r => {
    const rr = explainByOrder.get(r.order_id);
    const topReason = rr?.explain_json?.reasons?.[0]?.label;
    return {
      order_no: r.order_no,
      customer_name: r.customer_name,
      confidence: r.confidence ?? 0,
      topReason,
    };
  });

  // 高频扣分原因 code
  const codeCount: Record<string, number> = {};
  for (const rr of runtimeRows) {
    const reasons = rr?.explain_json?.reasons || [];
    for (const reason of reasons) {
      if (reason.code) codeCount[reason.code] = (codeCount[reason.code] || 0) + 1;
    }
  }
  const topReasonCodes = Object.entries(codeCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));

  const failedOrders = rows
    .filter(r => !r.ok)
    .map(r => ({ order_no: r.order_no, error: r.error || 'unknown' }));

  return {
    ranAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startTs) / 1000),
    totals: { total, ok, failed, skipped },
    distribution,
    confidence,
    topRed,
    topReasonCodes,
    failedOrders,
  };
}

function printReport(r: Report) {
  console.log('\n');
  console.log('════════════════════════════════════════');
  console.log('  分布报告');
  console.log('════════════════════════════════════════');
  console.log(`运行时间: ${r.durationSec} 秒`);
  console.log(`总订单数: ${r.totals.total}`);
  console.log(`成功计算: ${r.totals.ok}`);
  console.log(`失败数:   ${r.totals.failed}`);
  console.log(`跳过数:   ${r.totals.skipped}`);
  console.log('');
  console.log('── 风险等级分布 ──');
  console.log(`  🟢 green:  ${r.distribution.green.count.toString().padStart(4)} (${r.distribution.green.pct})`);
  console.log(`  🟡 yellow: ${r.distribution.yellow.count.toString().padStart(4)} (${r.distribution.yellow.pct})`);
  console.log(`  🟠 orange: ${r.distribution.orange.count.toString().padStart(4)} (${r.distribution.orange.pct})`);
  console.log(`  🔴 red:    ${r.distribution.red.count.toString().padStart(4)} (${r.distribution.red.pct})`);
  if (r.distribution.gray.count > 0) {
    console.log(`  ⚪ gray:   ${r.distribution.gray.count.toString().padStart(4)} (${r.distribution.gray.pct})`);
  }
  console.log('');
  console.log('── Confidence 数值分布 ──');
  console.log(`  平均: ${r.confidence.avg}`);
  console.log(`  中位: ${r.confidence.median}`);
  console.log(`  最低: ${r.confidence.min}`);
  console.log(`  最高: ${r.confidence.max}`);
  console.log('');

  if (r.topRed.length > 0) {
    console.log('── Top Red 订单（前 10 个最低置信度）──');
    r.topRed.forEach((t, i) => {
      console.log(`  ${i + 1}. [${t.confidence}%] ${t.order_no} (${t.customer_name || '—'})`);
      if (t.topReason) console.log(`        ↳ ${t.topReason}`);
    });
    console.log('');
  }

  if (r.topReasonCodes.length > 0) {
    console.log('── 高频扣分原因 (code) ──');
    r.topReasonCodes.forEach((rc, i) => {
      console.log(`  ${(i + 1).toString().padStart(2)}. ${rc.code.padEnd(40)} ${rc.count} 次`);
    });
    console.log('');
  }

  if (r.failedOrders.length > 0) {
    console.log('── 失败订单清单 ──');
    r.failedOrders.forEach(f => {
      console.log(`  ❌ ${f.order_no}: ${f.error}`);
    });
    console.log('');
  }
}

function saveReport(r: Report) {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), 'docs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `runtime-backfill-report-${today}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2), 'utf-8');
  console.log(`📄 报告已保存: ${file}`);
}

// ─────────────────────────────────────────────────────────────
// 算法可信度评估闸门
// ─────────────────────────────────────────────────────────────

function assessVerdict(r: Report): { message: string; exitCode: number } {
  const ok = r.totals.ok;
  if (ok === 0) {
    return { message: '⚠️  没有成功计算任何订单，无法评估算法', exitCode: 1 };
  }
  const redPct = (r.distribution.red.count / ok) * 100;
  const orangeRedPct = ((r.distribution.orange.count + r.distribution.red.count) / ok) * 100;

  if (redPct > 30) {
    return {
      message:
        `🚫 算法警告：red 占比 ${redPct.toFixed(1)}% > 30%。\n` +
        `   不要进入 Day 8/9。建议：\n` +
        `   1. 审查 Top Red 订单是否真的危险（人工抽样 5 单）\n` +
        `   2. 回到 Day 3 调权重（可能扣分太狠）\n` +
        `   3. 调整后重跑 backfill`,
      exitCode: 1,
    };
  }
  if (orangeRedPct > 50) {
    return {
      message:
        `⚠️  算法谨慎：orange + red 占比 ${orangeRedPct.toFixed(1)}% > 50%。\n` +
        `   建议人工抽样 10 单验证：\n` +
        `   - 如果抽样的红/橙订单确实有问题 → 算法可信，进 Day 8\n` +
        `   - 如果一半以上抽样订单实际正常 → 回 Day 3 调参`,
      exitCode: 0,
    };
  }
  return {
    message:
      `✅ 算法分布合理（red ${redPct.toFixed(1)}%, orange+red ${orangeRedPct.toFixed(1)}%）\n` +
      `   可以进入 Day 8（文档 + 测试补全）`,
    exitCode: 0,
  };
}

main().catch(e => {
  console.error('\n💥 backfill 崩溃:', e);
  process.exit(1);
});
