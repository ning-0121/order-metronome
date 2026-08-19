/**
 * 清除 1022962 八条采购项的补采标记(CEO 2026-08-18:「其实是正常下单」)。
 *
 * 背景:补采标记由 afterProcurementPlaced 启发式自动打(过了采购下单节点才归并出的新项),
 * 补录场景(线下已正常采购,回系统补录 BOM)会被误判 —— 数据上与漏采无法区分。
 * CEO 已明确判定这批是正常下单 → 标记属误打,予以清除;财务批准记录保留(已发生的事实)。
 * 审计走 writeAuditEvent(A2),留「谁判定、为什么清」。默认 dry-run。
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
const OID = (o as any).id;
const { data: items } = await sb.from('procurement_items')
  .select('id, item_no, material_name, is_supplement, supplement_reason, finance_approval_status')
  .eq('order_id', OID).eq('is_supplement', true);
const rows = (items ?? []) as any[];
console.log(`\n${APPLY ? '⚙️ 执行' : '🔍 DRY-RUN'} —— 清补采标记 ${rows.length} 条(财务批准记录保留):`);
for (const r of rows) console.log(`  ${r.item_no} ${r.material_name}  is_supplement true→false · reason「${r.supplement_reason}」→null`);
if (!APPLY) { console.log('\n(未写库,--apply 执行)\n'); process.exit(0); }

let ok = 0;
for (const r of rows) {
  const { error } = await sb.from('procurement_items')
    .update({ is_supplement: false, supplement_reason: null, updated_at: new Date().toISOString() })
    .eq('id', r.id).eq('is_supplement', true);
  if (error) console.error(`  ✗ ${r.item_no}: ${error.message}`); else ok++;
}
try {
  const { writeAuditEvent } = await import('../lib/audit/write-audit-event.ts');
  await writeAuditEvent({
    eventType: 'supplement_flag_cleared', level: 'A2', riskLevel: 'money',
    actor: { actorType: 'user', actorId: ALEX },
    entity: { entityType: 'order', entityId: OID, orderId: OID },
    commandName: 'clear-supplement-flag-1022962',
    reason: 'CEO 判定:该批为补录的正常采购,非漏采。补采标记系 afterProcurementPlaced 启发式误打,予以清除;此前的财务批准记录保留。',
    beforeState: { is_supplement_count: rows.length },
    afterState: { is_supplement_count: 0 },
    metadata: { item_nos: rows.map((r) => r.item_no) },
  } as any);
  console.log('📝 审计事件已写(A2 supplement_flag_cleared)');
} catch (e: any) { console.warn('审计写入失败(标记已清):', e?.message); }
const { count } = await sb.from('procurement_items').select('id',{count:'exact',head:true}).eq('order_id',OID).eq('is_supplement',true);
console.log(`\n✅ 已清 ${ok}/${rows.length};回读:剩余补采标记 = ${count ?? '?'}${(count??1)===0?' 🔎 清零':''}\n`);
