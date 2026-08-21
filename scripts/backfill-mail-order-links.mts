/**
 * 存量邮件 → 订单关联回填(2026-08-21)。
 *
 * 背景:parseEmailForOrderInfo 的 PO 提取一直 push 整串「PO 613」而不是捕获组
 * 「613」,拿去查 order_no/po_number 永远查不到。实测 3997 封邮件里 150 封主题
 * 含「PO 数字」,关联成功 0 封 —— 这条路径自上线起从未生效。
 *
 * 代码已修,但存量邮件不会自己重跑(email-scan 只处理 last_processed_at is null)。
 * 这个脚本只回填 mail_inbox.order_id,**不触发任何 AI、不改分类摘要、不发通知**。
 *
 * 默认 dry-run 只打印 before → after。加 --apply 才落库。
 *
 * 匹配口径与线上一致:提取到的号 → orders.order_no / po_number / internal_order_no
 * 精确相等。只回填 order_id 为空的邮件;命中多个订单的一律跳过并列出来,由人判断。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { parseEmailForOrderInfo } from '../lib/utils/imap-fetch';

for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

async function retry<T>(fn: () => Promise<T>, n = 6): Promise<T> {
  let last: any;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

/** 分页取全量,避开 Supabase 默认 1000 行静默截断。 */
async function pageAll(table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r: any = await retry(() => (sb.from(table) as any).select(cols).range(from, from + 999));
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...r.data);
    if (r.data.length < 1000) return out;
  }
}

const orders = await pageAll('orders', 'id, order_no, po_number, internal_order_no, customer_name');
// 一个号可能对应多张单(PO 号复用),记成数组,冲突的不自动回填
// 按 id 去重:同一张单的 po_number 与 internal_order_no 常常相等(613 这类),
// 不去重会把「同一张单进了两次索引」误判成「一个号命中两张单」而全部跳过。
const index = new Map<string, any[]>();
for (const o of orders) {
  for (const key of [o.order_no, o.po_number, o.internal_order_no]) {
    if (!key) continue;
    const k = String(key).trim();
    const cur = index.get(k) || [];
    if (!cur.some(x => x.id === o.id)) index.set(k, [...cur, o]);
  }
}

const mails = await pageAll('mail_inbox', 'id, subject, order_id, customer_id, received_at');
const pending = mails.filter(m => !m.order_id);

const plan: { id: string; subject: string; po: string; order: any }[] = [];
const ambiguous: string[] = [];
let noPo = 0, poNotInDb = 0;

for (const m of pending) {
  const { poNumbers } = parseEmailForOrderInfo(String(m.subject || ''), '');
  if (!poNumbers.length) { noPo++; continue; }
  let hit: any[] | undefined;
  let hitPo = '';
  for (const po of poNumbers) {
    const found = index.get(po);
    if (found?.length) { hit = found; hitPo = po; break; }
  }
  if (!hit) { poNotInDb++; continue; }
  if (hit.length > 1) {
    ambiguous.push(`  ${hitPo} → ${hit.map(o => o.order_no).join(' / ')}  | ${String(m.subject).slice(0, 44)}`);
    continue;
  }
  plan.push({ id: m.id, subject: String(m.subject || ''), po: hitPo, order: hit[0] });
}

console.log(`邮件总数 ${mails.length} · 其中未关联订单 ${pending.length}`);
console.log(`  主题无 PO 号: ${noPo}`);
console.log(`  有 PO 号但库里查不到(客户自己的款号/物流号): ${poNotInDb}`);
console.log(`  ⚠️ 一个号命中多张单,跳过待人工判断: ${ambiguous.length}`);
if (ambiguous.length) console.log(ambiguous.slice(0, 10).join('\n'));
console.log(`\n✅ 可回填: ${plan.length} 封\n`);
for (const p of plan.slice(0, 25)) {
  console.log(`  ${p.po} → ${p.order.order_no} (${p.order.customer_name || '—'})`);
  console.log(`      order_id: (空) → ${p.order.id}`);
  console.log(`      ${p.subject.slice(0, 60)}`);
}
if (plan.length > 25) console.log(`  … 另有 ${plan.length - 25} 封`);

if (!APPLY) {
  console.log(`\n[DRY-RUN] 未落库。确认无误后加 --apply 执行。`);
  process.exit(0);
}

console.log(`\n[APPLY] 开始回填 ${plan.length} 封…`);
let ok = 0, fail = 0;
for (const p of plan) {
  const { error } = await (sb.from('mail_inbox') as any)
    .update({ order_id: p.order.id, customer_id: p.order.customer_name || null })
    .eq('id', p.id);
  if (error) { fail++; console.error(`  ❌ ${p.po}: ${error.message}`); } else ok++;
}
console.log(`回填完成: 成功 ${ok} · 失败 ${fail}`);
