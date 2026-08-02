import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const e=resolve(process.cwd(),'.env.local');
if (existsSync(e)) for (const l of readFileSync(e,'utf-8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
const s=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
// 从迁移文件里搜出所有 create table 的表名
const names=new Set<string>();
for(const f of readdirSync('supabase/migrations')){
  if(!f.endsWith('.sql'))continue;
  const t=readFileSync('supabase/migrations/'+f,'utf-8');
  for(const m of t.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z0-9_]+)/gi)) names.add(m[1]);
}
// 代码里引用过的表
const { execSync } = await import('node:child_process');
const blob=execSync('grep -rhoE "from\\([\'\\"]([a-z0-9_]+)[\'\\"]\\)" app lib components || true',{encoding:'utf-8'});
for(const m of blob.matchAll(/from\(['"]([a-z0-9_]+)['"]\)/g)) names.add(m[1]);
const list=[...names].sort();
console.log(`候选表 ${list.length} 个,逐个数行…\n`);
const res:Array<{t:string;n:number|null;err?:string}>=[];
for(const t of list){
  let got=false;
  for(let i=0;i<3&&!got;i++){
    try{ const {count,error}=await s.from(t).select('*',{count:'exact',head:true});
      if(error){ if(/does not exist|schema cache/i.test(error.message)){res.push({t,n:null,err:'不存在'});got=true;} else if(i===2){res.push({t,n:null,err:error.message.slice(0,40)});got=true;} }
      else {res.push({t,n:count??0});got=true;}
    }catch{ }
    if(!got) await sleep(500*(i+1));
  }
  if(!got) res.push({t,n:null,err:'查询失败'});
}
const empty=res.filter(r=>r.n===0);
const gone=res.filter(r=>r.err==='不存在');
const used=res.filter(r=>(r.n??0)>0);
console.log(`有数据 ${used.length} · 空表 ${empty.length} · 库里不存在 ${gone.length}\n`);
console.log('【空表 —— 功能建了但从没产生过数据】');
for(const r of empty) console.log('   '+r.t);
console.log('\n【代码引用但库里没有的表】');
for(const r of gone) console.log('   '+r.t);
