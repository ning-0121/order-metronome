/** Procurement Pilot 013(1022982)出发前只读体检。不写任何表。 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPilotOrder } from '../lib/procurement/pilot.ts';
import { isBasisConfirmed } from '../lib/procurement/consumption-basis.ts';
import { normalizeAllocationMode } from '../lib/procurement/trimAllocation.ts';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p,'utf-8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth:{persistSession:false}});
const OID='74bde1e4-85c6-48fe-b55c-be47bd7914e9';
let blockers=0, warns=0;
const chk=(n:string,ok:boolean,d='')=>{ if(!ok) blockers++; console.log(`${ok?'✅':'❌ BLOCKER'} ${n}${d?` — ${d}`:''}`); };
const warn=(n:string,ok:boolean,d='')=>{ if(!ok) warns++; console.log(`${ok?'✅':'⚠️  WARNING'} ${n}${d?` — ${d}`:''}`); };

const { data: o } = await sb.from('orders').select('*').eq('id',OID).maybeSingle(); const oo:any=o;
console.log(`\n═══ Pilot 体检:${oo.order_no} / ${oo.internal_order_no} (${oo.customer_name}) ═══\n`);

chk('1 Pilot 白名单命中', isPilotOrder({ order_no: oo.order_no, internal_order_no: oo.internal_order_no }, { PROCUREMENT_GENERATOR_PILOT: 'QM-20260806-013' } as any), 'env=QM-20260806-013');

const { data: bom } = await sb.from('materials_bom').select('*').eq('order_id',OID);
const B=(bom??[]) as any[];
chk('2 BOM 存在', B.length>0, `${B.length} 行(面料${B.filter(b=>b.material_type==='fabric').length}/辅料${B.filter(b=>b.material_type!=='fabric').length})`);
const noBasis=B.filter(b=>!isBasisConfirmed(b.consumption_basis));
chk('3 consumption_basis 完整', noBasis.length===0, noBasis.length?`缺 ${noBasis.length} 项:${noBasis.map(b=>b.material_name).join('、')}`:'全部已确认');
const modes=B.map(b=>`${b.material_name}=${normalizeAllocationMode(b.allocation_mode)}`);
warn('4 allocation_mode 已声明', B.some(b=>normalizeAllocationMode(b.allocation_mode)!=='whole_order'), modes.join(' · '));

const { data: li } = await sb.from('order_line_items').select('style_no,color_cn,color_en,sizes,qty_pcs,set_multiplier').eq('order_id',OID);
const keys=[...new Set((li??[]).flatMap((r:any)=>Object.keys(r.sizes||{})))];
chk('5 SKU 矩阵干净', !keys.some(k=>/qty|pcs|total|合计|小计|数量|箱/i.test(k)), `尺码键:${keys.join('/')}`);

const { data: am } = await sb.from('order_amendments').select('id,status').eq('order_id',OID).eq('status','pending');
chk('6 无 pending 改单', (am??[]).length===0, `${(am??[]).length} 条`);

let pcs=0; for(const r of (li??[]) as any[]) pcs += (Number(r.qty_pcs)||0)*(Number(r.set_multiplier)>0?Number(r.set_multiplier):1);
chk('7 订单头与明细数量一致', pcs===Number(oo.quantity), `头 ${oo.quantity} 件 / 明细 ${pcs} 件`);

const { count: pi } = await sb.from('procurement_items').select('id',{count:'exact',head:true}).eq('order_id',OID);
chk('8 尚无 procurement_items(干净起点)', (pi??0)===0, `${pi??0} 条`);
const { count: pl } = await sb.from('procurement_line_items').select('id',{count:'exact',head:true}).eq('order_id',OID);
chk('9 尚无执行行', (pl??0)===0, `${pl??0} 条`);

const { data: dr } = await sb.from('delay_requests').select('id,status').eq('order_id',OID).eq('status','pending');
chk('10 无会改数量的 pending 变更', (dr??[]).length===0, `pending 延期 ${(dr??[]).length} 条`);

const { data: fin } = await sb.from('order_financials').select('sale_total,exchange_rate').eq('order_id',OID).maybeSingle();
const f:any=fin; const expect=Math.round(Number(oo.unit_price)*Number(oo.quantity)*(Number(f?.exchange_rate)||7.2)*100)/100;
warn('11 财务与现数量一致(独立 warning,不吞)', Math.abs(Number(f?.sale_total)-expect)<1, `sale_total ${f?.sale_total} vs 按现数量应为 ${expect}(差 ${Math.round((Number(f?.sale_total)-expect)*100)/100})`);

console.log(`\n${blockers===0?'🎉 preflight 通过':`⛔ ${blockers} 个 BLOCKER,不得开跑`}${warns?` · ${warns} 个 warning`:''}\n`);
process.exit(blockers===0?0:1);
