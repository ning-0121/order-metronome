/**
 * 关闭历史邮件积压(2026-08-21 CEO:历史不补,只保证从今往后不再积压)。
 *
 * 背景:email-scan 长期 504(IMAP 与 AI 分析挤在同一个 60s 函数里),深度分析
 * 一封都没跑完;而取件范围又写死「最近 24 小时」,超期的永远进不了候选集 ——
 * 实测积压到 38 天 / 990 封 processing_status='pending'。
 *
 * 这些邮件**已经有分类和摘要**(那是 mail-digest 另一条链路做的),
 * 缺的只是深度分析(AI 匹配订单/比对数量交期/生成草稿)。补做要花近千次 AI 调用,
 * 且多为过期信息 → CEO 拍板不补。
 *
 * 但也不能让它们永远挂着 pending 假装待办:
 *   · 邮件监控页会一直显示"待处理"
 *   · 新的 email-scan 取件条件是 last_processed_at is null + 7 天窗口,
 *     7 天外的本来也进不来,状态却停在 pending —— 名实不符
 * 所以统一标 skipped 并写明原因,账面与事实对齐。
 *
 * 只读跑:node --import tsx scripts/close-stale-mail-backlog.mts
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

/** 与 email-scan 的取件窗口一致 —— 窗口内的留给它正常处理,只收窗口外的。 */
const WINDOW_DAYS = 7;
const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

async function R<T>(f: () => Promise<T>, n = 6): Promise<T> {
  let e: any; for (let i = 0; i < n; i++) { try { return await f(); } catch (x) { e = x; await new Promise(r => setTimeout(r, 1200 * (i + 1))); } } throw e;
}

// 分页取全量 —— 单次 select 默认封顶 1000 行,直接用会**静默截断**。
// (本次排查就先后被它误导两次:先报 990 封、再报 1000 封,实际 3794。)
const rows: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await R(() => sb.from('mail_inbox')
    .select('id, subject, received_at, created_at, category')
    .eq('processing_status', 'pending')
    .is('last_processed_at', null)
    .lt('received_at', cutoff)
    .order('received_at', { ascending: true })
    .range(from, from + 999) as any) as any;
  if (error) { console.error('✗ 查询失败:', error.message); process.exit(1); }
  rows.push(...(data || []));
  if ((data || []).length < 1000) break;
}

console.log(APPLY ? '=== 执行 ===' : '=== DRY-RUN(只读) ===');
console.log(`\n窗口外(> ${WINDOW_DAYS} 天)且从未处理的 pending 邮件: ${rows.length} 封`);
if (rows.length) {
  const oldest = rows[0], newest = rows[rows.length - 1];
  console.log(`  最老 ${String(oldest.received_at).slice(0, 10)} · 最新 ${String(newest.received_at).slice(0, 10)}`);
  const byCat: Record<string, number> = {};
  for (const r of rows) byCat[String(r.category ?? '(无分类)')] = (byCat[String(r.category ?? '(无分类)')] || 0) + 1;
  console.log('  分类分布(证明摘要链路是好的,缺的只是深度分析):');
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${k.padEnd(16)} ${v}`);
}
console.log(`\n窗口内(≤ ${WINDOW_DAYS} 天)的不动 —— 留给 email-scan 正常处理。`);
if (!APPLY) { console.log('\n加 --apply 才落库'); process.exit(0); }
if (!rows.length) { console.log('无需处理'); process.exit(0); }

writeFileSync('/tmp/mail-backlog-closed.json', JSON.stringify(rows.map((r: any) => r.id), null, 2));
console.log('\n备份(可据此回滚为 pending) → /tmp/mail-backlog-closed.json');
let ok = 0;
for (let i = 0; i < rows.length; i += 200) {
  const ids = rows.slice(i, i + 200).map((r: any) => r.id);
  const { data: upd, error: uErr } = await R(() => sb.from('mail_inbox')
    .update({
      processing_status: 'skipped',
      last_processed_at: new Date().toISOString(),
    }).in('id', ids).select('id') as any) as any;
  if (uErr) { console.error(`✗ 第 ${i} 批: ${uErr.message}`); continue; }
  ok += (upd || []).length;
}
console.log(`✓ 已关闭 ${ok}/${rows.length} 封(标 skipped,分类与摘要保留不动)`);
