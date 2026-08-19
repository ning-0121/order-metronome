/**
 * 1022977 采购项总需刷新 —— 一次性落地(2026-08-18,CEO 四催)。
 *
 * 为什么走脚本:自动刷新已上线,但只在「下次提交/归并」触发;这单的提交都发生在
 * 修复部署之前,而界面上已无待提交项、无人再触发 → 数字一直停在 08-12 的 2×。
 *
 * 纪律:**不另写算法**。逐行 = pieces_qty × production_consumption(与 consolidate
 * 的 fabric 分支同式),分组键 = 线上同一个 consolidationKey,建议采购 = 线上同一个
 * computeSuggestedPurchaseQty。只 UPDATE 既有项(等价 create:false, refresh:true);
 * 采购填的最终量不动,但按 2026-08-18 新规置 needs_reconfirm(人按旧基数拍的板要重确认)。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { consolidationKey, computeSuggestedPurchaseQty } from '../lib/services/procurement-consolidation.ts';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p,'utf-8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth:{persistSession:false}});
const APPLY = process.argv.includes('--apply');
const ALEX = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';

const { data: o } = await sb.from('orders').select('id').eq('internal_order_no','1022977').maybeSingle();
const OID = (o as any).id;
const { data: reqs } = await sb.from('material_requirements').select('*').eq('order_id',OID);
const slIds = [...new Set((reqs??[]).map((r:any)=>r.snapshot_line_id).filter(Boolean))];
const { data: sls } = await sb.from('material_package_snapshot_lines').select('id, color, specification, qty_per_piece, bom_id, material_name, loss_rate').in('id',slIds);
const slMap = new Map((sls??[]).map((s:any)=>[s.id,s]));
const bomIds = [...new Set((sls??[]).map((s:any)=>s.bom_id).filter(Boolean))];
const { data: bs } = await sb.from('materials_bom').select('id, material_master_id, production_consumption, over_purchase_pct, customer_supplied, factory_supplied').in('id',bomIds);
const bomX = new Map((bs??[]).map((b:any)=>[b.id,b]));

// 与 consolidate 同构的分组(此单无人工合并映射,无客供行)
const groups = new Map<string, any>();
for (const r of (reqs??[]) as any[]) {
  const sl:any = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
  const bx:any = sl?.bom_id ? bomX.get(sl.bom_id) : null;
  if (bx?.customer_supplied || bx?.factory_supplied) continue;
  const key = consolidationKey({ material_master_id: bx?.material_master_id ?? null, material_name: r.material_name ?? sl?.material_name ?? null, specification: sl?.specification ?? null, category: r.category ?? null, color: sl?.color ?? null, unit: r.unit ?? null });
  const pieces = Number(r.pieces_qty) > 0 ? Number(r.pieces_qty) : null;
  const prod = bx?.production_consumption != null && Number(bx.production_consumption) > 0 ? Number(bx.production_consumption) : null;
  const isFabric = r.category === 'fabric';
  const lineTotal = isFabric
    ? (prod != null && pieces != null ? pieces * prod : NaN)
    : ((prod != null && pieces != null) ? pieces * prod : Number(r.net_purchase_qty) || 0);
  if (Number.isNaN(lineTotal)) {
    // 线上 consolidate 会因此整单拒绝 —— 这就是「点了刷新也没反应」的另一半真相。
    // 本脚本是 refresh-only(等价 create:false):缺单耗的组本来就没有既有采购项可刷,
    // 跳过它,不让它拦住另外两条的刷新;并明确提示业务补单耗。
    console.log(`  ⚠️ 跳过「${r.material_name}」:布料未核定大货单耗(无既有采购项,不影响本次刷新;业务需在原辅料页补齐)`);
    continue;
  }
  const g = groups.get(key) || { total: 0, devTop: null, devTopNet: -1, overTop: 0 };
  g.total += lineTotal;
  const net = Number(r.net_purchase_qty) || 0;
  if (net > g.devTopNet) { g.devTopNet = net; g.devTop = sl?.qty_per_piece != null ? Number(sl.qty_per_piece) : null; g.overTop = Number(bx?.over_purchase_pct) > 0 ? Number(bx.over_purchase_pct) : 0; }
  groups.set(key, g);
}
for (const g of groups.values()) g.total = Math.round(g.total * 10) / 10;

const { data: items } = await sb.from('procurement_items').select('id, item_no, consolidation_key, material_name, color, total_required_qty, final_purchase_qty, production_consumption, procurement_loss_pct, safety_stock_qty, moq, status').eq('order_id',OID);
console.log(`\n${APPLY?'⚙️ 执行':'🔍 DRY-RUN'} —— 1022977 总需刷新(权威源=material_requirements 08-14):`);
const plan: any[] = [];
for (const it of (items??[]) as any[]) {
  const g = groups.get(it.consolidation_key);
  if (!g) { console.log(`  ${it.item_no} 无匹配需求组,跳过`); continue; }
  const suggested = computeSuggestedPurchaseQty({ total_required_qty: g.total, development_consumption: it.production_consumption ?? g.devTop, production_consumption: it.production_consumption, procurement_loss_pct: g.overTop, safety_stock_qty: it.safety_stock_qty, moq: it.moq });
  const changed = Number(it.total_required_qty) !== g.total;
  const reconfirm = changed && (it.status !== 'draft' || it.final_purchase_qty != null);
  console.log(`  ${it.item_no} ${it.material_name}/${it.color}: 总需 ${it.total_required_qty} → ${g.total} · 建议 → ${suggested} · 最终 ${it.final_purchase_qty}(不动${reconfirm?',标需重确认':''})`);
  if (changed) plan.push({ id: it.id, total: g.total, suggested, reconfirm });
}
if (!APPLY) { console.log('\n(未写库,--apply 执行)\n'); process.exit(0); }
let ok=0;
for (const u of plan) {
  const { error } = await sb.from('procurement_items').update({ total_required_qty: u.total, suggested_purchase_qty: u.suggested, needs_reconfirm: u.reconfirm, updated_at: new Date().toISOString() }).eq('id', u.id);
  if (error) console.error('  ✗', error.message); else ok++;
}
try {
  const { writeAuditEvent } = await import('../lib/audit/write-audit-event.ts');
  await writeAuditEvent({ eventType:'procurement_totals_refreshed', level:'A2', riskLevel:'money',
    actor:{actorType:'user',actorId:ALEX}, entity:{entityType:'order',entityId:OID,orderId:OID},
    commandName:'refresh-1022977-totals', reason:'MRP 08-14 已重算(数量语义修复后),采购项停在 08-12 的 2× 旧值;自动刷新上线前的存量单一次性落地。算法组件与线上同源(consolidationKey/computeSuggestedPurchaseQty)。',
    beforeState:{ totals:[11616,6336] }, afterState:{ totals: plan.map(x=>x.total) }, metadata:{ needs_reconfirm: true } } as any);
  console.log('📝 审计已写');
} catch(e:any){ console.warn('审计失败(数据已改):', e?.message); }
const { data: verify } = await sb.from('procurement_items').select('item_no,total_required_qty,needs_reconfirm').eq('order_id',OID);
console.log(`\n✅ 更新 ${ok}/${plan.length};回读:`, (verify??[]).map((v:any)=>`${v.item_no}=${v.total_required_qty}(reconfirm=${v.needs_reconfirm})`).join(' · '), '\n');
