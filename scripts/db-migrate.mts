/**
 * 迁移运行器(2026-07-24 · 根因1 修复:消灭手动粘迁移导致的 schema drift)。
 *
 * 用 service-role + exec_sql RPC 自动 apply supabase/migrations 里【未执行】的迁移,
 * 用 public._app_migrations 记录已执行的文件,防重复。零新依赖,不需要 DB 连接串。
 *
 * 先决条件:在 Supabase SQL Editor 粘贴执行一次 scripts/db/bootstrap.sql(建追踪表 + exec_sql)。
 *
 * 命令:
 *   npm run db:status      查看 已执行 N / 待执行 M(+ 列出待执行文件)
 *   npm run db:baseline    把【当前所有】迁移标记为"已执行"(不真跑)——首次接入用:
 *                          因为历史迁移是手动粘过的,基线化后只有【新增】文件才会被 apply。
 *   npm run db:migrate     apply 所有待执行迁移(按文件名顺序,逐条 exec_sql,成功后记录)
 *   npm run db:migrate -- --dry   只列出会执行什么,不真跑
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { splitSql } from './db/sql-split.ts';

// ── 零依赖加载 .env.local ──
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY(.env.local)'); process.exit(1); }
const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const MIG_DIR = resolve(process.cwd(), 'supabase/migrations');

const allMigrations = (): string[] =>
  readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();

async function getApplied(): Promise<Set<string> | null> {
  const { data, error } = await (db.from('_app_migrations') as any).select('name');
  if (error) {
    if (/_app_migrations|does not exist|schema cache|could not find/i.test(error.message || '')) return null; // 未自举
    console.error('❌ 读 _app_migrations 失败:', error.message); process.exit(1);
  }
  return new Set((data || []).map((r: any) => r.name));
}

function needBootstrap(): never {
  console.error('❌ 还没自举。请先在 Supabase SQL Editor 粘贴执行一次:');
  console.error('   scripts/db/bootstrap.sql');
  console.error('   (建 _app_migrations 追踪表 + exec_sql RPC)');
  process.exit(1);
}

async function execSql(sql: string): Promise<string | null> {
  const { error } = await (db.rpc as any)('exec_sql', { sql });
  return error ? (error.message || String(error)) : null;
}

async function main() {
  const cmd = process.argv[2] || 'migrate';
  const dry = process.argv.includes('--dry');
  const applied = await getApplied();
  if (applied === null) needBootstrap();
  const files = allMigrations();
  const pending = files.filter(f => !applied!.has(f));

  if (cmd === 'status') {
    console.log(`📦 迁移:已执行 ${applied!.size} · 待执行 ${pending.length} · 目录共 ${files.length}`);
    if (pending.length) { console.log('\n待执行:'); pending.forEach(f => console.log('  • ' + f)); }
    else console.log('✅ 全部已执行,无待跑迁移。');
    return;
  }

  if (cmd === 'baseline') {
    const rows = files.filter(f => !applied!.has(f)).map(f => ({ name: f, statements: null }));
    if (!rows.length) { console.log('✅ 已全部基线化,无需操作。'); return; }
    if (dry) { console.log(`将基线化(标记为已执行,不真跑)${rows.length} 个文件。`); return; }
    const { error } = await (db.from('_app_migrations') as any).insert(rows);
    if (error) { console.error('❌ 基线化失败:', error.message); process.exit(1); }
    console.log(`✅ 已基线化 ${rows.length} 个迁移为"已执行"。之后只有【新增】文件会被 apply。`);
    return;
  }

  if (cmd === 'migrate') {
    if (!pending.length) { console.log('✅ 无待执行迁移。'); return; }
    console.log(`📦 待执行 ${pending.length} 个迁移${dry ? '(dry-run,不真跑)' : ''}:`);
    for (const f of pending) {
      const sql = readFileSync(join(MIG_DIR, f), 'utf-8');
      const stmts = splitSql(sql);
      if (dry) { console.log(`  • ${f}  (${stmts.length} 条语句)`); continue; }
      process.stdout.write(`  ▶ ${f} (${stmts.length} 条)… `);
      for (let s = 0; s < stmts.length; s++) {
        const err = await execSql(stmts[s]);
        if (err) {
          console.log('❌');
          console.error(`\n第 ${s + 1}/${stmts.length} 条语句失败:\n${stmts[s].slice(0, 400)}\n\n错误:${err}`);
          console.error(`\n⛔ 已停在 ${f}。修好后重跑 db:migrate(前面成功的幂等语句会自动跳过)。`);
          process.exit(1);
        }
      }
      const { error: recErr } = await (db.from('_app_migrations') as any).insert({ name: f, statements: stmts.length });
      if (recErr) { console.log('⚠'); console.error(`  语句都跑过了,但记录 ${f} 失败:${recErr.message}(下次会重跑,幂等则无害)`); }
      else console.log('✅');
    }
    console.log('\n🎉 迁移全部执行完成。');
    return;
  }

  console.error(`未知命令:${cmd}。可用:status | baseline | migrate [--dry]`);
  process.exit(1);
}

main().catch(e => { console.error('❌ 运行器异常:', e?.message || e); process.exit(1); });
