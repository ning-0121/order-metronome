/**
 * 部门考核历史回填(2026-08-20)—— on_time 一律 null,只留「做过这件事」的事实。
 *
 * 为什么不判准时:on_time 靠节点 due_at 算,而本轮审计已证明 due_at 对大量历史节点虚高
 * (工作台 217 个「逾期」里 108 个是滚动排期下还没轮到做、28 个是待收尾单)。
 * 拿不可靠的锚点给部门打分,比没有数据更糟 → 回填保留 target_date 备查,
 * 但 on_time 置 null。computeDeptScore 只统计 on_time===true|false,null 自动跳过,
 * 不影响准时率与分数(已核实 lib/domain/deptAssessment.ts)。
 *
 * 幂等:按 (order_id,department,task_key) 跳过已存在的,绝不覆盖真实判定过的记录。
 * 只读跑:node --import tsx scripts/backfill-dept-assessments.mts
 * 落库:  加 --apply
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

// 映射与线上钩子共用同一份(lib/domain/deptAssessment.ts)——不再各抄一份
import { DEPT_TASK_BY_STEP as MAP } from '../lib/domain/deptAssessment.ts';
const DONE = new Set(['done', '已完成', 'completed']);
const TERMINAL = new Set(['cancelled', '已取消', 'archived', '已归档']);

async function R<T>(f: () => Promise<T>, n = 6): Promise<T> {
  let e: any; for (let i = 0; i < n; i++) { try { return await f(); } catch (x) { e = x; await new Promise(r => setTimeout(r, 1200 * (i + 1))); } } throw e;
}
async function page(t: string, cols: string) {
  const out: any[] = []; let f = 0; const S = 1000;
  for (;;) { const r: any = await R(() => sb.from(t).select(cols).range(f, f + S - 1) as any);
    if (r.error) { console.error(`✗ ${t}: ${r.error.message}`); process.exit(1); }
    out.push(...(r.data || [])); if ((r.data || []).length < S) break; f += S; }
  return out;
}

const orders = await page('orders', 'id,internal_order_no,order_no,lifecycle_status,order_purpose');
const oMap = new Map(orders.map((o: any) => [o.id, o]));
const ms = await page('milestones', 'order_id,step_key,status,due_at,actual_at,completed_at,owner_user_id');
const exist: any = await R(() => sb.from('department_assessments').select('order_id,department,task_key') as any);
if (exist.error) { console.error('✗ department_assessments:', exist.error.message); process.exit(1); }
const has = new Set((exist.data || []).map((x: any) => `${x.order_id}¦${x.department}¦${x.task_key}`));

const rows: any[] = [];
let skipExist = 0, skipTerm = 0, skipSample = 0;
for (const m of ms as any[]) {
  const mp = MAP[m.step_key]; if (!mp) continue;
  const st = String(m.status || '');
  if (!DONE.has(st.toLowerCase()) && !DONE.has(st)) continue;
  const o: any = oMap.get(m.order_id); if (!o) continue;
  if (String(o.order_purpose) === 'sample') { skipSample++; continue; }
  if (TERMINAL.has(String(o.lifecycle_status || '').toLowerCase())) { skipTerm++; continue; }
  if (has.has(`${m.order_id}¦${mp.dept}¦${mp.key}`)) { skipExist++; continue; }
  const actual = (m.actual_at || m.completed_at) ? String(m.actual_at || m.completed_at).slice(0, 10) : null;
  rows.push({
    order_id: m.order_id, department: mp.dept, task_key: mp.key, task_label: mp.label,
    user_id: m.owner_user_id || null,
    target_date: m.due_at ? String(m.due_at).slice(0, 10) : null,
    actual_date: actual,
    on_time: null,   // ← 刻意不判:due_at 对历史节点不可靠,见文件头
    note: '历史回填(2026-08-20)·未判准时:due_at 口径对历史节点不可靠',
    updated_at: new Date().toISOString(),
  });
}
const byTask: Record<string, number> = {};
for (const r of rows) byTask[`${r.department}/${r.task_key}`] = (byTask[`${r.department}/${r.task_key}`] || 0) + 1;
console.log(APPLY ? '=== 执行回填 ===' : '=== DRY-RUN(只读) ===');
console.log(`\n将写入 ${rows.length} 条 · 涉及订单 ${new Set(rows.map(r => r.order_id)).size} 张\n`);
for (const [k, v] of Object.entries(byTask).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${v}`);
console.log(`\n跳过:已有记录 ${skipExist} · 已终结订单 ${skipTerm} · 打样单 ${skipSample}`);
console.log(`现有 department_assessments ${(exist.data || []).length} 条 → 回填后 ${(exist.data || []).length + rows.length} 条`);
console.log(`on_time 一律 null → computeDeptScore 的 assessed 不变,部门分数不受影响`);
if (!APPLY) { console.log('\n加 --apply 才落库'); process.exit(0); }
writeFileSync('/tmp/dept-assessment-backfill.json', JSON.stringify(rows, null, 2));
console.log('\n备份(可据此删除) → /tmp/dept-assessment-backfill.json');
let ok = 0;
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  const { data, error } = await R(() => sb.from('department_assessments')
    .upsert(chunk, { onConflict: 'order_id,department,task_key' }).select('id') as any) as any;
  if (error) { console.error(`✗ 第 ${i} 批: ${error.message}`); continue; }
  ok += (data || []).length;
}
console.log(`✓ 已写入 ${ok}/${rows.length} 条`);
