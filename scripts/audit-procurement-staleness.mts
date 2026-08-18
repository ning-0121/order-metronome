/**
 * 只读盘点:MRP 与采购项失步的订单(2026-08-18)。
 *
 * 判定用**结构性指标**而非重算数量:
 *   material_requirements 最新生成时间 > procurement_items 最后更新时间
 *   → 需求已重算,采购项还停在上一版 = 采购正在消费旧事实。
 * 刻意不在这里复刻 consolidate 的算法(会算出与线上不同的数,反而误导)。
 * 数量差只作为佐证展示。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data: orders } = await sb.from('orders').select('id, order_no, internal_order_no, lifecycle_status');
const oMap = new Map((orders ?? []).map((o: any) => [o.id, o]));

const { data: reqs } = await sb.from('material_requirements').select('order_id, created_at');
const reqLatest = new Map<string, string>();
for (const r of (reqs ?? []) as any[]) {
  const cur = reqLatest.get(r.order_id);
  if (!cur || r.created_at > cur) reqLatest.set(r.order_id, r.created_at);
}

const { data: items } = await sb.from('procurement_items').select('order_id, item_no, material_name, color, total_required_qty, final_purchase_qty, status, updated_at, created_at');
const byOrder = new Map<string, any[]>();
for (const it of (items ?? []) as any[]) {
  if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
  byOrder.get(it.order_id)!.push(it);
}

const stale: any[] = [];
for (const [oid, its] of byOrder) {
  const rq = reqLatest.get(oid);
  if (!rq) continue;
  const lastTouch = its.map((i) => i.updated_at || i.created_at).sort().pop()!;
  if (rq > lastTouch) {
    const o: any = oMap.get(oid);
    stale.push({
      no: o?.internal_order_no ?? o?.order_no ?? oid.slice(0, 8),
      lc: o?.lifecycle_status,
      reqAt: String(rq).slice(0, 16).replace('T', ' '),
      itemAt: String(lastTouch).slice(0, 16).replace('T', ' '),
      n: its.length,
      withFinal: its.filter((i) => i.final_purchase_qty != null).length,
      nonDraft: its.filter((i) => i.status !== 'draft').length,
    });
  }
}
stale.sort((a, b) => (a.itemAt < b.itemAt ? -1 : 1));
console.log(`\n有采购项的订单 ${byOrder.size} 张 · **需求晚于采购项刷新(已失步)${stale.length} 张**\n`);
console.log('单号        状态       需求重算于        采购项停在        项数 已填最终 非草稿');
for (const s of stale) {
  console.log(`${String(s.no).padEnd(11)} ${String(s.lc).padEnd(10)} ${s.reqAt}  ${s.itemAt}  ${String(s.n).padStart(3)} ${String(s.withFinal).padStart(6)} ${String(s.nonDraft).padStart(6)}`);
}
const risky = stale.filter((s) => s.withFinal > 0);
console.log(`\n其中 ${risky.length} 张已被采购填过「最终量」—— 刷新总需后这些最终量是按旧基数填的,必须提示重新确认。`);
console.log('※ 本脚本只读,未修改任何数据。\n');
