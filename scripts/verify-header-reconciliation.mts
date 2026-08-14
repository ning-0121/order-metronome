/**
 * HEADER_RECONCILIATION 生产验收 —— 只读,不写任何东西。
 *
 * 用法:npx tsx scripts/verify-header-reconciliation.mts 1022982 1022969
 *
 * 五项独立查库(不看 UI 说了什么,只看库里是什么):
 *   ① orders.quantity   是否 == 明细物理合计
 *   ② orders.total_amount 是否 == 单价 × 明细商业量(数量语义:unit_price 是每套价)
 *   ③ line_items         是否**没被改动**(updated_at 早于本次对齐)
 *   ④ audit              是否有 quantity_header_reconciled_from_line_items 事件
 *   ⑤ finance sync       是否有对应的同步记录
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { sumPhysicalPieceQty, sumCommercialQty } from '@/lib/domain/line-item-quantity';

for (const l of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const i = l.indexOf('='); if (i < 0 || l.trim().startsWith('#')) continue;
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const targets = process.argv.slice(2);
if (targets.length === 0) { console.error('用法: npx tsx scripts/verify-header-reconciliation.mts <内部单号...>'); process.exit(1); }

const ok = (b: boolean) => (b ? '✅ PASS' : '❌ FAIL');
let allPass = true;

for (const ino of targets) {
  const { data: o } = await svc.from('orders')
    .select('id, order_no, quantity, unit_price, total_amount, updated_at')
    .eq('internal_order_no', ino).maybeSingle();
  if (!o) { console.log(`\n■ ${ino}  ❌ 订单不存在`); allPass = false; continue; }
  const oid = (o as any).id;

  const { data: li } = await svc.from('order_line_items')
    .select('qty_pcs, set_multiplier, updated_at').eq('order_id', oid);
  const rows = (li || []) as any[];
  const phys = sumPhysicalPieceQty(rows);
  const comm = sumCommercialQty(rows);
  const up = Number((o as any).unit_price);
  const amt = Number((o as any).total_amount);
  const expectAmt = Number.isFinite(up) && comm > 0 ? Math.round(up * comm * 100) / 100 : null;

  // ③ 明细最后改动时间 vs 订单头最后改动时间:对齐只动头,明细应更早
  const liLatest = rows.reduce((m, r) => (String(r.updated_at) > m ? String(r.updated_at) : m), '');
  const ordUpdated = String((o as any).updated_at);

  const { data: ev } = await svc.from('order_logs')
    .select('action, created_at')
    .eq('order_id', oid).eq('action', 'quantity_header_reconciled_from_line_items')
    .order('created_at', { ascending: false }).limit(1)
    .then((r) => r, () => ({ data: null } as any));

  const { data: fin } = await svc.from('synced_orders')
    .select('id, updated_at').eq('order_id', oid).limit(1)
    .then((r) => r, () => ({ data: null } as any));

  const c1 = Number((o as any).quantity) === phys;
  const c2 = expectAmt == null || Math.abs(amt - expectAmt) < 0.01;
  const c3 = !liLatest || liLatest <= ordUpdated;
  const c4 = !!(ev && (ev as any[]).length);
  const c5 = !!(fin && (fin as any[]).length);
  if (!(c1 && c2 && c3 && c4)) allPass = false;

  console.log(`\n■ ${ino}  (${(o as any).order_no})`);
  console.log(`  ① 订单头数量 == 明细物理合计   ${ok(c1)}   ${(o as any).quantity} vs ${phys}`);
  console.log(`  ② 金额 == 单价 × 商业量        ${ok(c2)}   ${amt} vs ${expectAmt}  (${up} × ${comm} 套)`);
  console.log(`  ③ 明细未被改动                 ${ok(c3)}   明细最后改 ${liLatest.slice(0, 19)} / 订单头 ${ordUpdated.slice(0, 19)}`);
  console.log(`  ④ 有对齐审计事件               ${ok(c4)}   ${c4 ? String((ev as any[])[0].created_at).slice(0, 19) : '未找到'}`);
  console.log(`  ⑤ 财务已同步                   ${c5 ? '✅' : '⚠️ 无记录(非阻断)'}`);
}

console.log(`\n${allPass ? '✅ 全部 PASS' : '❌ 有项未通过 —— 先停,不要继续 Pilot'}`);
