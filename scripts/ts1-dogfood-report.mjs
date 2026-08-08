#!/usr/bin/env node
/** TS1 Founder Dogfood Report —— CEO 真实用满 N 次后一键出 11 项指标。用法:node scripts/ts1-dogfood-report.mjs */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env.local','utf-8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
const s=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: ev } = await s.from('exec_validation_events').select('*').order('created_at',{ascending:true});
const rows = ev || [];
const total = rows.length;
if (!total) { console.log('还没有 dogfood 数据 —— 去 /executive 真实用几次'); process.exit(0); }
const confirmed = rows.filter(r=>r.outcome==='confirmed').length;
const abandoned = rows.filter(r=>r.outcome==='abandoned').length;
const lat = rows.map(r=>r.extraction_latency_ms).filter(x=>x!=null);
const avgLat = lat.length ? Math.round(lat.reduce((a,b)=>a+b,0)/lat.length) : null;
const corr = rows.map(r=>r.ceo_correction_count).filter(x=>x!=null);
const over2 = corr.filter(c=>c>2).length;
const zeroOrOne = corr.filter(c=>c<=1).length;
console.log(`\n════ TS1 Founder Dogfood Report(${total} 次)════`);
console.log(`1. total captures        : ${total}`);
console.log(`2. confirmed rate        : ${confirmed}/${total} = ${Math.round(confirmed/total*100)}%`);
console.log(`3. abandoned rate        : ${abandoned}/${total} = ${Math.round(abandoned/total*100)}%`);
console.log(`4. avg extraction latency: ${avgLat}ms  (门槛 <10000ms 为主)`);
console.log(`5. ≤1 处修改的占比       : ${confirmed?Math.round(zeroOrOne/confirmed*100):0}% (${zeroOrOne}/${confirmed} 确认单)`);
console.log(`6-8. 字段修改(合并计)   : CEO 平均改 ${corr.length?(corr.reduce((a,b)=>a+b,0)/corr.length).toFixed(1):'—'} 处/单`);
console.log(`9. >2 处修改的次数        : ${over2}  (门槛 ≤10%,即 ≤${Math.ceil(total*0.1)} 次)`);
console.log(`10. hallucination         : 需人工标注(telemetry 只记结构,幻觉靠你确认时判断)`);
console.log(`11. 抽取字段分布(看常见失败):`);
const kinds={}; for(const r of rows){for(const f of (r.extracted_fields||[])){kinds[f.item_type]=(kinds[f.item_type]||0)+1;}}
console.log('    ', JSON.stringify(kinds));
console.log(`\n判定门槛:确认率高 + ≤1改占比≥90% + >2改率≤10% + 延迟<10s + 你主观觉得比微信/记脑子方便`);
