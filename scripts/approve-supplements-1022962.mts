/**
 * 批准 1022962 的 8 条补采购(CEO 2026-08-18 对话拍板「先A」)。
 * 语义:这批是**补录历史采购**(采购下单节点 7-24 完成,BOM 8-18 补录),
 * 财务批准 = 知情确认进应付,不是新的花钱决定。
 * 写法与 approveSupplement 完全一致(该 action 无通知/外发副作用,仅一个 update);
 * 批准人记 Alex(admin,FINANCE_ROLES 含 admin)。默认 dry-run,--apply 执行。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p,'utf-8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth:{persistSession:false}});
const APPLY = process.argv.includes('--apply');
const ALEX = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';

const { data: o } = await sb.from('orders').select('id').eq('internal_order_no','1022962').maybeSingle();
const { data: items } = await sb.from('procurement_items')
  .select('id, item_no, material_name, color, total_required_qty, unit, is_supplement, finance_approval_status')
  .eq('order_id',(o as any).id).eq('is_supplement',true).eq('finance_approval_status','pending');
const rows=(items??[]) as any[];
console.log(`\n${APPLY?'⚙️ 执行':'🔍 DRY-RUN'} —— 待批补采购 ${rows.length} 条:`);
for (const r of rows) console.log(`  ${r.item_no} ${r.material_name}${r.color?'/'+r.color:''} ${r.total_required_qty}${r.unit??''}  pending → approved(by Alex)`);
if (!APPLY) { console.log('\n(未写库,--apply 执行)\n'); process.exit(0); }

const now = new Date().toISOString();
let ok=0;
for (const r of rows) {
  const { error } = await sb.from('procurement_items').update({
    finance_approval_status:'approved', finance_approved_by:ALEX, finance_approved_at:now,
    finance_reject_reason:null, updated_at:now,
  }).eq('id',r.id).eq('finance_approval_status','pending');   // CAS 防并发
  if (error) console.error(`  ✗ ${r.item_no}: ${error.message}`); else ok++;
}
const { data: verify } = await sb.from('procurement_items').select('finance_approval_status').eq('order_id',(o as any).id).eq('is_supplement',true);
const remaining=(verify??[]).filter((v:any)=>v.finance_approval_status==='pending').length;
console.log(`\n✅ 已批准 ${ok}/${rows.length};回读:剩余 pending = ${remaining}${remaining===0?' 🔎 全部清零':' ❌ 有残留'}\n`);
