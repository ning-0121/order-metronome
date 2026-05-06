/**
 * Day 4 集成测试 — recomputeDeliveryConfidence
 *
 * 这是 **真打 DB** 的集成测试，需要：
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - 已执行 20260506_runtime_phase1_tables.sql
 *
 * 运行：
 *   RUNTIME_CONFIDENCE_ENGINE=admin npx tsx scripts/test-recompute-confidence.ts
 *
 * 默认自动挑：
 *   - 1 个"高风险"订单：当前有 in_progress 关键节点已超期 ≥ 3 天的
 *   - 1 个"普通"订单：所有未完成节点都未到期
 *
 * 也可以指定订单号：
 *   npx tsx scripts/test-recompute-confidence.ts QM-20260427-001 QM-20260403-015
 *
 * 验收：
 *   - 两次 trigger 都返回 ok
 *   - runtime_events 各新增 1 条
 *   - runtime_orders 写入成功，version 递增
 *   - explain_json 含 headline / reasons / next_action
 *   - 重试不会重复写 event（每次 trigger 是独立 event）
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import {
  recomputeDeliveryConfidence,
  getRuntimeOrder,
  listRecentRuntimeEvents,
} from '../app/actions/runtime-confidence';

// 测试运行时 force 把 flag 打开（不影响 prod env）
process.env.RUNTIME_CONFIDENCE_ENGINE = process.env.RUNTIME_CONFIDENCE_ENGINE || 'admin';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const sys = createSupabaseClient(url, key);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: any, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}

function section(name: string) { console.log(`\n▶ ${name}`); }

// ─────────────────────────────────────────────────────────────
// 自动挑两个订单
// ─────────────────────────────────────────────────────────────

async function pickRiskyOrder(): Promise<string | null> {
  const today = new Date().toISOString();
  // 找 active 订单：含至少一个 in_progress 关键节点超期 ≥ 3 天
  const { data: critOverdue } = await (sys.from('milestones') as any)
    .select('order_id, step_key, due_at, status')
    .in('step_key', ['production_kickoff', 'factory_completion', 'booking_done', 'final_qc_check'])
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', today)
    .limit(50);

  if (!critOverdue || critOverdue.length === 0) return null;

  for (const m of critOverdue) {
    const { data: order } = await (sys.from('orders') as any)
      .select('id, order_no, lifecycle_status')
      .eq('id', m.order_id)
      .maybeSingle();
    if (order && !['cancelled', '已取消', 'completed', '已完成'].includes(order.lifecycle_status)) {
      return order.order_no;
    }
  }
  return null;
}

async function pickCalmOrder(): Promise<string | null> {
  // 找一个 active 订单，且没有任何 in_progress 节点超期
  const today = new Date().toISOString();
  const { data: orders } = await (sys.from('orders') as any)
    .select('id, order_no, factory_date, lifecycle_status, created_at')
    .eq('lifecycle_status', 'active')
    .gt('factory_date', today)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!orders) return null;
  for (const o of orders) {
    const { data: overdueMs } = await (sys.from('milestones') as any)
      .select('id')
      .eq('order_id', o.id)
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', today)
      .limit(1);
    if (!overdueMs || overdueMs.length === 0) return o.order_no;
  }
  return null;
}

async function orderNoToId(orderNo: string): Promise<string | null> {
  const { data } = await (sys.from('orders') as any)
    .select('id')
    .eq('order_no', orderNo)
    .single();
  return data?.id || null;
}

// ─────────────────────────────────────────────────────────────
// 主测试流程
// ─────────────────────────────────────────────────────────────

async function testOnOrder(orderNo: string, scenario: string) {
  section(`${scenario} — ${orderNo}`);
  const orderId = await orderNoToId(orderNo);
  if (!orderId) { assert(false, `订单 ${orderNo} 存在`); return; }
  assert(true, `订单 ${orderNo} 存在`);

  // 拍快照：当前 runtime_orders + events 计数
  const before = await getRuntimeOrder(orderId);
  const beforeVersion = before.data?.version ?? 0;

  // 第一次 trigger
  const r1 = await recomputeDeliveryConfidence(orderId, {
    type: 'external_signal',
    source: `test:${scenario}:1`,
    severity: 'info',
    payload: { trigger: 'manual-test', scenario, attempt: 1 },
  });

  assert(r1.ok, '第一次 recompute 返回 ok', JSON.stringify(r1));
  if (r1.ok && r1.data) {
    assert(typeof r1.data.confidence === 'number', 'confidence 是数字');
    assert(r1.data.confidence >= 0 && r1.data.confidence <= 100,
      `confidence ∈ [0, 100]：实际 ${r1.data.confidence}`);
    assert(['green', 'yellow', 'orange', 'red', 'gray'].includes(r1.data.riskLevel),
      `riskLevel 合法：${r1.data.riskLevel}`);
    assert(/[🟢🟡🟠🔴⚪]/.test(r1.data.explainHeadline),
      `headline 含 emoji：${r1.data.explainHeadline}`);
    assert(typeof r1.data.eventId === 'string',
      `eventId 已写入：${r1.data.eventId}`);
    assert(r1.data.version === beforeVersion + 1,
      `version 递增到 ${beforeVersion + 1}：实际 ${r1.data.version}`);
  }

  // 第二次 trigger（验证 version 继续递增 + event 是新条）
  const r2 = await recomputeDeliveryConfidence(orderId, {
    type: 'external_signal',
    source: `test:${scenario}:2`,
    severity: 'info',
    payload: { trigger: 'manual-test', scenario, attempt: 2 },
  });

  assert(r2.ok, '第二次 recompute 返回 ok');
  if (r2.ok && r2.data && r1.ok && r1.data) {
    assert(r2.data.version === r1.data.version + 1,
      `version 继续递增：${r1.data.version} → ${r2.data.version}`);
    assert(r2.data.eventId !== r1.data.eventId, 'event 是新条（不复用）');
  }

  // 验证 runtime_orders 现状
  const after = await getRuntimeOrder(orderId);
  assert(!!after.data, 'runtime_orders 已存在记录');
  if (after.data) {
    const explain: any = after.data.explain_json;
    assert(!!explain, 'explain_json 不为空');
    if (explain) {
      assert(typeof explain.headline === 'string', 'explain.headline 是字符串');
      assert(Array.isArray(explain.reasons), 'explain.reasons 是数组');
      assert('next_blocker' in explain, 'explain 含 next_blocker 字段');
      assert('next_action' in explain, 'explain 含 next_action 字段');
      assert(typeof explain.computed_at === 'string', 'explain.computed_at 是 ISO');
    }
  }

  // 验证 runtime_events 至少有这次跑的 2 条
  const events = await listRecentRuntimeEvents(orderId, 5);
  assert(!!events.data, 'listRecentRuntimeEvents 不报错');
  if (events.data) {
    const fromThisRun = events.data.filter(e =>
      e.event_source === `test:${scenario}:1` || e.event_source === `test:${scenario}:2`
    );
    assert(fromThisRun.length === 2, `本次跑的 2 条 event 都在：实际 ${fromThisRun.length}`);
    // 永远不删除：每条都有 created_at + payload_json
    for (const ev of fromThisRun) {
      assert(!!ev.created_at, 'event 有 created_at');
      assert(!!ev.payload_json, 'event 含 payload_json');
    }
  }

  // 打印一份给人看
  console.log('   ─── 投影后状态 ───');
  console.log(`   confidence: ${after.data?.delivery_confidence}`);
  console.log(`   risk_level: ${after.data?.risk_level}`);
  console.log(`   headline:   ${(after.data?.explain_json as any)?.headline}`);
  console.log(`   next_blocker: ${(after.data?.explain_json as any)?.next_blocker?.name || '—'}`);
  console.log(`   next_action: ${(after.data?.explain_json as any)?.next_action || '—'}`);
}

// ─────────────────────────────────────────────────────────────
// 异常 case：不存在的订单
// ─────────────────────────────────────────────────────────────

async function testInvalidOrder() {
  section('异常 case — 不存在的订单');
  const r = await recomputeDeliveryConfidence('00000000-0000-0000-0000-000000000000', {
    type: 'external_signal',
    source: 'test:invalid',
  });
  assert(!r.ok, '应返回 ok=false');
  assert(typeof r.error === 'string', '应返回 error 文案');
  console.log(`   error: ${r.error}`);
}

// ─────────────────────────────────────────────────────────────
// flag 关闭 case
// ─────────────────────────────────────────────────────────────

async function testFlagOff() {
  section('flag 关闭 case — RUNTIME_CONFIDENCE_ENGINE=off');
  const original = process.env.RUNTIME_CONFIDENCE_ENGINE;
  process.env.RUNTIME_CONFIDENCE_ENGINE = 'off';

  const r = await recomputeDeliveryConfidence('00000000-0000-0000-0000-000000000000', {
    type: 'external_signal',
    source: 'test:flag-off',
  });
  assert(r.ok === true, 'ok=true（投影关闭时返回 ok 让钩子无脑调用）');
  assert(r.skipped === true, 'skipped=true');

  process.env.RUNTIME_CONFIDENCE_ENGINE = original;
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  let riskyNo: string | null = argv[0] || null;
  let calmNo: string | null = argv[1] || null;

  if (!riskyNo) riskyNo = await pickRiskyOrder();
  if (!calmNo) calmNo = await pickCalmOrder();

  console.log('════════════════════════════════════════');
  console.log('Runtime Confidence 集成测试 (Day 4)');
  console.log('════════════════════════════════════════');
  console.log(`高风险订单: ${riskyNo || '(none found)'}`);
  console.log(`普通订单:   ${calmNo || '(none found)'}`);

  if (riskyNo) await testOnOrder(riskyNo, 'high-risk');
  else console.log('\n⚠ 跳过 high-risk 测试：DB 中没有符合条件的订单');

  if (calmNo) await testOnOrder(calmNo, 'normal');
  else console.log('\n⚠ 跳过 normal 测试：DB 中没有符合条件的订单');

  await testInvalidOrder();
  await testFlagOff();

  console.log('\n════════════════════════════════════════');
  console.log(`✅ 通过: ${pass}`);
  console.log(`❌ 失败: ${fail}`);
  console.log('════════════════════════════════════════');
  if (fail > 0) {
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\n🎉 集成测试全部通过');
}

main().catch(e => {
  console.error('\n💥 集成测试崩溃:', e);
  process.exit(1);
});
