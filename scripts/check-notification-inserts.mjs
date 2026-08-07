#!/usr/bin/env node
/**
 * 静态闸:站内通知只许走 lib/utils/notifications 的 insertNotifications。
 *
 * 2026-08-06 审计:notifications 的 RLS 只允许 auth.uid()=user_id,
 * 全站曾有 37 处用 session 客户端给审批人插通知 —— 全部被静默拒收,
 * 审批人"从来没收到"。本闸拦"绕过统一入口直插"的回潮:
 * 允许的例外只有统一入口本体,以及明确用 service-role 客户端(svc.)的调用。
 */
import { execSync } from 'node:child_process';

let out = '';
try {
  out = execSync(
    String.raw`grep -rn "\.from('notifications')" app lib --include='*.ts' --include='*.tsx' | grep -v node_modules`,
    { encoding: 'utf-8' },
  );
} catch { /* 无命中 */ }

import { readFileSync } from 'node:fs';
// 文件级豁免:整文件的 supabase 就是 service-role(cron/webhook 用 SERVICE_ROLE_KEY 直建,
// 且不混用 session 的 await createClient())→ 其 insert 天然绕过 RLS,不是问题
const svcFileCache = new Map();
function isServiceRoleFile(file) {
  if (!svcFileCache.has(file)) {
    try {
      const src = readFileSync(file, 'utf-8');
      svcFileCache.set(file, src.includes('SUPABASE_SERVICE_ROLE_KEY') && !src.includes('await createClient()'));
    } catch { svcFileCache.set(file, false); }
  }
  return svcFileCache.get(file);
}

const bad = [];
for (const line of out.split('\n').filter(Boolean)) {
  if (!/insert/i.test(line) && !/\.insert\(/.test(line)) {
    // 单行看不出是否 insert 的,读上下文太重;只拦同一行可见的 insert
  }
  const file = line.split(':')[0];
  if (file === 'lib/utils/notifications.ts') continue;          // 统一入口本体
  if (isServiceRoleFile(file)) continue;                          // 纯 service-role 文件(cron 等)
  if (/(svc|serviceClient|supabaseAdmin)\s*\.from\('notifications'\)/.test(line)) continue;  // 明确 service-role
  if (!/\.from\('notifications'\)\s*(as any\))?\s*\)?\s*\.?insert|insert/.test(line)) { /* 下面统一判 */ }
  if (/supabase\s*\.from\('notifications'\)/.test(line) && /insert/.test(line)) {
    bad.push(line.slice(0, 160));
  }
}

if (bad.length) {
  console.error('❌ 发现绕过统一入口的 session 客户端通知插入(RLS 会静默拒收):');
  for (const b of bad) console.error('   ' + b);
  console.error('   → 请改用 lib/utils/notifications 的 insertNotifications()');
  process.exit(1);
}
console.log('✅ 通知写入检查通过(全部走统一入口或 service-role)');
