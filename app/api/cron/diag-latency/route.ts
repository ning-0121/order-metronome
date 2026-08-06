/**
 * 临时探针 —— 量「Vercel 函数 ↔ Supabase」的真实往返延迟。
 *
 * 为什么需要:要不要把库迁到亚洲区,取决于瓶颈在哪一段。
 *   用户(义乌) → Vercel 边缘(香港) → 函数(iad1 美东) → 库(?)
 * 如果函数和库同区,函数↔库 ~1-3ms,一个页面十几个查询也才几十毫秒,迁库没意义;
 * 如果跨区(比如库在新加坡而函数在美东),每个查询 +150ms,十几个串行查询就是 2 秒 ——
 * 那才是「很卡」的真凶。这个数只能在函数里量,本机量的是我到库的距离,没有参考价值。
 *
 * ⚠️ 用完即删。只读、不碰业务数据,查的是 profiles 的 count。
 * 放在 /api/cron/ 下是为了走已有的 CRON_SECRET 鉴权,不额外开公开端点。
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'missing env' }, { status: 500 });

  const supabase = createClient(url, key);
  const samples: number[] = [];

  // 连打 8 次最轻量的查询 —— 第一次含 TLS 握手,后面才是稳态往返
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    await supabase.from('profiles').select('*', { count: 'exact', head: true });
    samples.push(Date.now() - t);
  }

  // 顺带量一次真实业务查询(订单头 + 节点),看单查询开销
  const t2 = Date.now();
  const { data: orders } = await supabase
    .from('orders').select('id').limit(300);
  const ordersMs = Date.now() - t2;

  const t3 = Date.now();
  const { data: ms } = await supabase
    .from('milestones').select('order_id, status').limit(1000);
  const msMs = Date.now() - t3;

  const steady = samples.slice(1);
  return NextResponse.json({
    region: process.env.VERCEL_REGION ?? '(unknown)',
    dbRoundTripMs: {
      first: samples[0],
      samples: steady,
      min: Math.min(...steady),
      median: steady.sort((a, b) => a - b)[Math.floor(steady.length / 2)],
    },
    realQueries: {
      orders300: { ms: ordersMs, rows: orders?.length ?? 0 },
      milestones1000: { ms: msMs, rows: ms?.length ?? 0 },
    },
  });
}
