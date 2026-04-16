/**
 * 审计：采购订单下达节点下"不是 Excel/PDF"的附件
 *
 * 场景：2026-04-15 发现有订单把微信截图当采购单上传了（.png），
 * 此脚本帮你一次性找出所有类似历史数据。
 *
 * 用法：
 *   1. 在 .env.local 中加上 SUPABASE_SERVICE_ROLE_KEY=xxx
 *      （从 Supabase Dashboard → Settings → API → service_role 复制）
 *   2. npx tsx scripts/audit-procurement-files.ts
 *
 * 或者：直接跑 scripts/audit-procurement-files.sql（粘到 Supabase SQL Editor）
 *
 * ⚠️ service_role key 权限大，别提交到 git，别泄露。
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// 手动加载 .env.local（零依赖，避免引入 dotenv）
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL');
  process.exit(1);
}
if (!SERVICE_ROLE_KEY) {
  console.error('❌ 缺 SUPABASE_SERVICE_ROLE_KEY');
  console.error('   在 Supabase Dashboard → Settings → API → service_role 复制 key');
  console.error('   加到 .env.local：SUPABASE_SERVICE_ROLE_KEY=eyJ...');
  console.error('');
  console.error('💡 或者不用 key — 直接跑 scripts/audit-procurement-files.sql');
  process.exit(1);
}

const ALLOWED_EXTS = ['xlsx', 'xls', 'pdf'];

interface Row {
  id: string;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  file_url: string | null;
  created_at: string;
  uploaded_by: string | null;
  order_id: string;
  orders: { order_no: string; customer_name: string; lifecycle_status: string } | null;
  profiles?: { name: string | null; email: string | null } | null;
}

async function main() {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log('\n🔍 查找 采购订单下达 节点下不是 Excel/PDF 的附件...\n');

  // 1. 找出所有 procurement_order_placed 节点 id
  const { data: milestones, error: msErr } = await supabase
    .from('milestones')
    .select('id, order_id')
    .eq('step_key', 'procurement_order_placed');

  if (msErr) {
    console.error('❌ 查 milestones 失败:', msErr.message);
    process.exit(1);
  }
  if (!milestones || milestones.length === 0) {
    console.log('（无采购节点数据）');
    return;
  }

  const msIds = milestones.map((m: any) => m.id);
  console.log(`📌 采购节点总数：${msIds.length}\n`);

  // 2. 查这些节点下的所有附件
  const { data: attachments, error: attErr } = await supabase
    .from('order_attachments')
    .select('id, file_name, file_type, file_size, file_url, created_at, uploaded_by, order_id')
    .in('milestone_id', msIds)
    .order('created_at', { ascending: false });

  if (attErr) {
    console.error('❌ 查 attachments 失败:', attErr.message);
    process.exit(1);
  }

  const allCount = attachments?.length || 0;

  // 3. 筛出扩展名不在白名单的
  const bad = (attachments || []).filter((a: any) => {
    const ext = (a.file_name || '').split('.').pop()?.toLowerCase() || '';
    return !ALLOWED_EXTS.includes(ext);
  });

  console.log(`📊 采购节点附件总数：${allCount}`);
  console.log(`⚠️  不规范（非 Excel/PDF）：${bad.length} 个\n`);

  if (bad.length === 0) {
    console.log('🎉 所有采购附件都是规范的 Excel/PDF，没有问题！');
    return;
  }

  // 4. 拉取 orders 和 uploader 信息
  const orderIds = [...new Set(bad.map((a: any) => a.order_id))];
  const uploaderIds = [...new Set(bad.map((a: any) => a.uploaded_by).filter(Boolean))];

  const [ordersRes, profilesRes] = await Promise.all([
    supabase.from('orders').select('id, order_no, customer_name, lifecycle_status').in('id', orderIds),
    uploaderIds.length > 0
      ? supabase.from('profiles').select('user_id, name, email').in('user_id', uploaderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const orderMap = new Map<string, any>();
  (ordersRes.data || []).forEach((o: any) => orderMap.set(o.id, o));
  const profileMap = new Map<string, any>();
  (profilesRes.data || []).forEach((p: any) => profileMap.set(p.user_id, p));

  // 5. 按订单分组
  const byOrder = new Map<string, any[]>();
  for (const a of bad) {
    const arr = byOrder.get(a.order_id) || [];
    arr.push(a);
    byOrder.set(a.order_id, arr);
  }

  // 6. 按扩展名分布
  const extDist = new Map<string, number>();
  for (const a of bad) {
    const ext = (a.file_name || '').split('.').pop()?.toLowerCase() || '(无扩展名)';
    extDist.set(ext, (extDist.get(ext) || 0) + 1);
  }

  // 7. 输出
  console.log('━'.repeat(60));
  console.log('📈 按扩展名分布');
  console.log('━'.repeat(60));
  const sortedExts = Array.from(extDist.entries()).sort((a, b) => b[1] - a[1]);
  for (const [ext, n] of sortedExts) {
    console.log(`  .${ext.padEnd(10)} ${n} 个`);
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`📦 按订单分组（涉及 ${byOrder.size} 个订单）`);
  console.log('━'.repeat(60));
  const sortedOrders = Array.from(byOrder.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [orderId, files] of sortedOrders) {
    const order = orderMap.get(orderId);
    console.log(`\n🔹 ${order?.order_no || '(未知订单号)'} · ${order?.customer_name || '(未知客户)'}`);
    console.log(`   状态: ${order?.lifecycle_status || '—'} · 问题附件: ${files.length} 个`);
    for (const f of files) {
      const uploader = profileMap.get(f.uploaded_by);
      const ext = (f.file_name || '').split('.').pop()?.toLowerCase() || '—';
      const kb = f.file_size ? ` (${Math.round(f.file_size / 1024)}KB)` : '';
      const who = uploader?.name || uploader?.email?.split('@')[0] || '(未知)';
      const when = new Date(f.created_at).toLocaleDateString('zh-CN');
      console.log(`   · [.${ext}] ${f.file_name || '未命名'}${kb}`);
      console.log(`     上传: ${who} · ${when}`);
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log('💡 处理建议');
  console.log('━'.repeat(60));
  console.log('  1. 通知采购：以上订单的采购单需要重新上传正式的 Excel/PDF');
  console.log('  2. 新规：采购节点已限制只能上传 .xlsx/.xls/.pdf（已上线）');
  console.log('  3. 旧图片文件可以在订单详情页"订单资料"里删除');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ 脚本异常:', err.message);
  process.exit(1);
});
