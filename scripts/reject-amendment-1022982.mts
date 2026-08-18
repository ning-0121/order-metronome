/**
 * 驳回 1022982(QM-20260806-013)的 quantity_decrease 改单 —— Pilot 前置清理。
 *
 * CEO 2026-08-17 决定:该单要作为 Procurement Pilot,不能带着一个可能改变数量的
 * pending amendment 进场(Pilot 验的是 BOM→采购链,数量中途变会污染结论)。
 *
 * 事实核对(已验)::orders.quantity=960,明细合计 960 件 → 头与明细**已对齐**,
 * 改单请求的 1320→960 早已被人工应用过,这条申请确实不再需要。
 *
 * 写法与界面点击一致:safeMutation(带 CAS 防并发)+ insertNotifications(统一入口),
 * 不裸写库、不绕过通知。默认 dry-run,--apply 才执行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = await import('@supabase/supabase-js');
const { safeMutation } = await import('../lib/db/safe-mutation.ts');

const APPLY = process.argv.includes('--apply');
const AMENDMENT_ID = '60ad4693-9529-42bd-a8dd-d8afa42e7130';
const REVIEWER = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';   // Alex(admin/CEO)
const NOTE = '已通过订单头与明细对齐完成数量修正,本申请不再需要。';

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data: before } = await svc.from('order_amendments').select('*').eq('id', AMENDMENT_ID).maybeSingle();
if (!before) { console.error('改单不存在'); process.exit(1); }
const b: any = before;
console.log('\n改单现状:');
console.log(`  status=${b.status}  申请人=${b.requested_by}`);
console.log(`  变更=${JSON.stringify(b.fields_to_change)}  理由=${b.reason}`);
console.log(`\n将写入:status='rejected' · reviewed_by=${REVIEWER}(Alex) · admin_note="${NOTE}"`);
console.log(`并通知申请人(菁菁)改单被驳回。`);

if (b.status !== 'pending') { console.log(`\n⚠️ 当前状态已是 ${b.status},无需处理。`); process.exit(0); }
if (!APPLY) { console.log('\n(dry-run,未写库。加 --apply 执行)\n'); process.exit(0); }

const rj = await safeMutation({
  client: svc as any, table: 'order_amendments', operation: 'update',
  payload: { status: 'rejected', reviewed_by: REVIEWER, reviewed_at: new Date().toISOString(), admin_note: NOTE },
  predicate: { id: AMENDMENT_ID, status: 'pending' },   // CAS:与界面同款防并发
});
if (!(rj as any).ok) { console.error(`❌ 驳回未生效(${(rj as any).status}):${(rj as any).error}`); process.exit(1); }

const { insertNotifications } = await import('../lib/utils/notifications.ts');
try {
  await insertNotifications({
    user_id: b.requested_by, type: 'amendment_rejected', title: '❌ 你的改单被驳回',
    message: `改单被驳回:${NOTE}`, related_order_id: b.order_id,
  } as any);
  console.log('✅ 已通知申请人');
} catch (e: any) { console.warn('通知失败(不阻断):', e?.message); }

const { data: after } = await svc.from('order_amendments').select('status, reviewed_by, reviewed_at, admin_note').eq('id', AMENDMENT_ID).maybeSingle();
console.log('\n回读校验:', JSON.stringify(after));
console.log((after as any)?.status === 'rejected' ? '✅ 驳回已生效\n' : '❌ 回读状态不对\n');
