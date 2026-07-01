/**
 * Order Intake Activation — 首个 PO → Order 就绪验证器
 *
 * 运行：
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/ignite-first-po.ts
 *
 * 只读预检（service-role）——判定"首个 PO 能否点火"，并精确列出缺口。
 * 不建单（真实建单必须经登录会话走 /api/os/ignite-po 或 PO UI，且不绕过 createOrder/Kernel）。
 *
 * 检查：
 *   1. orders 已加 PO 绑定列（migration 已执行？）
 *   2. 至少 1 条 customer_po
 *   3. 该 PO 绑定的快照 is_approved（可消费）
 *   → 全过：READY，输出点火命令；否则：BLOCKED，列缺口。
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('❌ 需要 NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 环境变量');
  process.exit(2);
}
const db = createSupabaseClient(url, key);

let blocked = false;
function ok(label: string, detail = '') { console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); }
function bad(label: string, detail = '') { console.log(`  ⛔ ${label}${detail ? ' — ' + detail : ''}`); blocked = true; }

async function main() {
  console.log('\n▶ 1. orders PO 绑定列（migration 是否已执行）');
  const { data: cols, error: colErr } = await (db as any)
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public').eq('table_name', 'orders')
    .in('column_name', ['source', 'customer_po_id', 'quote_snapshot_version', 'origin_quote_id']);
  // information_schema 经 PostgREST 可能不可直接查；退回 RPC/直接建表探测
  let have: string[] = (cols || []).map((c: any) => c.column_name);
  if (colErr || have.length === 0) {
    // 退回：尝试 select 这些列，失败即视为缺失
    const probe = await (db as any).from('orders').select('source, customer_po_id, quote_snapshot_version').limit(1);
    if (probe.error) {
      bad('orders 缺 PO 绑定列', '请先在 Supabase 执行 20260701_orders_po_binding.sql');
      have = [];
    } else {
      have = ['source', 'customer_po_id', 'quote_snapshot_version'];
    }
  }
  for (const c of ['source', 'customer_po_id', 'quote_snapshot_version']) {
    have.includes(c) ? ok(`列 ${c} 存在`) : bad(`列 ${c} 缺失`);
  }

  console.log('\n▶ 2. customer_po 数据');
  const { data: pos, error: poErr } = await (db as any)
    .from('customer_po').select('id, po_number, quote_id, quote_snapshot_version').order('created_at', { ascending: false }).limit(1);
  if (poErr) { bad('读取 customer_po 失败', poErr.message); }
  else if (!pos || pos.length === 0) { bad('无 customer_po 行', '需先创建 PO（PO 由已审批报价生成）'); }
  else ok('存在 customer_po', `${(pos as any)[0].po_number}`);

  console.log('\n▶ 3. PO 绑定快照 approved');
  if (pos && pos.length > 0) {
    const po: any = (pos as any)[0];
    const { data: snap } = await (db as any)
      .from('quote_version_snapshot').select('version, is_approved')
      .eq('quote_id', po.quote_id).eq('version', po.quote_snapshot_version).maybeSingle();
    if (!snap) bad('快照缺失', `quote ${po.quote_id} v${po.quote_snapshot_version}`);
    else if (!snap.is_approved) bad('快照未 approved', '订单只能由已审批冻结快照派生');
    else ok('快照 approved', `v${snap.version}`);
  } else {
    bad('跳过快照检查（无 PO）');
  }

  console.log('\n' + '─'.repeat(52));
  if (blocked) {
    console.log('⛔ NOT READY — 上述缺口解决后可点火。');
    console.log('   点火（登录会话下）：POST /api/os/ignite-po');
    console.log('   body: { "poId": "<customer_po.id>", "operational": { "internal_order_no":"...", "order_type":"export", "incoterm":"DDP", "factory_date":"2026-08-01" } }');
    process.exit(1);
  }
  console.log('✅ READY — 首个 PO 可点火。');
  console.log('   POST /api/os/ignite-po  body: { poId: "' + (pos as any)[0].id + '", operational: {...} }');
  console.log('   成功后校验：orders.source=\'PO\' · customer_po_id 绑定 · quote_snapshot_version 绑定。');
}

main().catch((e) => { console.error('脚本异常：', e?.message || e); process.exit(2); });
