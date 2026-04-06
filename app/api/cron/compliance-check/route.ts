/**
 * 邮件-订单执行对照 Cron — 每日07:30北京时间
 *
 * 用 AI 对比业务员邮件 vs 系统订单状态，发现执行偏差
 */

import { createClient } from '@supabase/supabase-js';
import { runComplianceChecks } from '@/lib/agent/complianceCheck';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);

    const result = await runComplianceChecks(supabase);

    return NextResponse.json({
      success: true,
      totalFindings: result.findings.length,
      inserted: result.inserted,
      notified: result.notified,
    });
  } catch (err: any) {
    console.error('[compliance-check]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
