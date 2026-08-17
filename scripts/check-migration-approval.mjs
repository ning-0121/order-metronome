#!/usr/bin/env node
/**
 * 静态闸:生产迁移批准清单(MIGRATION-GOV-001)。
 *
 * 事故(2026-08-16):并行 session 在别的分支上跑 `npm run db:migrate`,
 * 我正在写的 `20260816_bom_allocation_mode.sql` 当时躺在共享工作区里 →
 * **被一起 apply 到了生产库**。这次是 nullable additive column 所以无害,
 * 下次可能是 DROP / constraint / RLS / index lock / backfill / enum change。
 *
 * 根因不是"谁忘了用 worktree":
 *   git 隔离的是**代码历史**,db:migrate 扫的是**当前 filesystem 的迁移目录**。
 *   → branch isolation ≠ migration isolation。
 *
 * 原则:
 *   Production migration is an explicit deployment artifact,
 *   not a side effect of repository state.
 *
 * 本闸只做一件很窄的事:**目录里的每个 .sql 都必须在 APPROVED.json 里**。
 * 于是"工作区里多出一个没人批准的迁移"在 `npm run check` 阶段就红,
 * 不用等到有人手滑跑 db:migrate。
 *
 * 加新迁移的正确姿势:在**同一个 commit** 里把文件名加进 APPROVED.json —— 可评审、可追溯。
 * 运行时还有第二道:db:migrate 会先列出执行计划,并拒绝执行任何未批准的迁移。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const MIG_DIR = resolve(process.cwd(), 'supabase/migrations');
const MANIFEST = join(MIG_DIR, 'APPROVED.json');

if (!existsSync(MIG_DIR)) {
  console.log('✅ 迁移批准检查跳过(无 supabase/migrations 目录)');
  process.exit(0);
}
if (!existsSync(MANIFEST)) {
  console.error('❌ 缺 supabase/migrations/APPROVED.json —— 生产迁移必须有显式批准清单(MIGRATION-GOV-001)');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
} catch (e) {
  console.error(`❌ APPROVED.json 解析失败:${e.message}`);
  process.exit(1);
}
const approved = new Set(Array.isArray(manifest.approved) ? manifest.approved : []);
if (approved.size === 0) {
  console.error('❌ APPROVED.json 的 approved 为空或格式不对(应为文件名数组)');
  process.exit(1);
}

const onDisk = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

// ① 目录里有、清单里没有 → 未批准的迁移(本次事故的形态)
const unapproved = onDisk.filter((f) => !approved.has(f));
// ② 清单里有、目录里没有 → 清单陈旧(文件被删/改名),同样要说出来
const missing = [...approved].filter((f) => !onDisk.includes(f)).sort();

if (unapproved.length) {
  console.error(`❌ 发现 ${unapproved.length} 个**未批准**的迁移文件(不在 APPROVED.json):`);
  for (const f of unapproved) console.error('   • ' + f);
  console.error('   → 若确属本次任务范围:把文件名加进 supabase/migrations/APPROVED.json,与迁移同 commit 提交;');
  console.error('   → 若是别的分支/别人的工作漂进来的:不要批准,先弄清它为什么在你的工作区。');
  console.error('   (MIGRATION-GOV-001:生产迁移是显式部署产物,不是仓库状态的副作用)');
  process.exit(1);
}

if (missing.length) {
  console.error(`❌ APPROVED.json 里有 ${missing.length} 个文件在目录中不存在(清单陈旧):`);
  for (const f of missing) console.error('   • ' + f);
  console.error('   → 已执行的历史迁移**不要删文件**;确属改名/清理,请同步更新清单并在 PR 说明。');
  process.exit(1);
}

console.log(`✅ 迁移批准检查通过(${onDisk.length} 个迁移均在 APPROVED.json 批准范围内)`);
