/**
 * 重新处理 mail_inbox 中所有未识别客户的邮件
 * GET /api/mail-reprocess
 */

import { createClient } from '@supabase/supabase-js';
import { identifyCustomerFromEmail } from '@/lib/agent/customerEmailMapping';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' });

    const supabase = createClient(url, serviceKey);
    const startTime = Date.now();

    // 拉取所有 customer_id 为 NULL 的邮件
    const { data: emails } = await supabase
      .from('mail_inbox')
      .select('id, from_email, subject, raw_body, received_at')
      .is('customer_id', null)
      .order('received_at', { ascending: false })
      .limit(100);

    if (!emails || emails.length === 0) {
      return NextResponse.json({ message: '没有需要重新处理的邮件', processed: 0 });
    }

    const results: any[] = [];
    let identified = 0;
    let matched = 0;

    for (const email of emails) {
      if (Date.now() - startTime > 50000) {
        results.push({ stopped: 'timeout' });
        break;
      }

      const idResult = await identifyCustomerFromEmail(
        supabase, email.from_email, email.subject, email.raw_body || ''
      );

      const customerName = idResult.customerName;

      // 生成 thread_id
      const threadSubject = email.subject
        .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
        .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
        .trim();
      const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

      // 尝试匹配订单
      let orderId: string | null = null;
      let orderNo: string | null = null;

      // 策略B: 主题数字
      const subjectClean = threadSubject.replace(/^#/, '');
      const numMatch = subjectClean.match(/^(\d{2,6})\b/);
      if (numMatch) orderNo = numMatch[1];

      // 策略C: 主题中所有数字
      if (!orderNo && customerName) {
        const allNums = threadSubject.match(/\d{3,6}/g) || [];
        for (const num of allNums) {
          const { data: poMatch } = await supabase.from('orders')
            .select('id').eq('po_number', num).eq('customer_name', customerName)
            .limit(1).maybeSingle();
          if (poMatch) { orderNo = num; break; }
        }
      }

      if (orderNo) {
        const { data: order } = await supabase.from('orders')
          .select('id').or(`order_no.eq.${orderNo},po_number.eq.${orderNo}`)
          .limit(1).maybeSingle();
        if (order) {
          orderId = order.id;
          matched++;
        }
      }

      // 更新 mail_inbox
      const { error } = await supabase.from('mail_inbox').update({
        customer_id: customerName,
        order_id: orderId,
        thread_id: threadId,
      }).eq('id', email.id);

      if (customerName) identified++;
      results.push({
        from: email.from_email,
        subject: email.subject,
        customer: customerName,
        orderId,
        error: error?.message || null,
      });
    }

    return NextResponse.json({
      processed: results.length,
      identified,
      matched,
      details: results.slice(0, 30),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, stack: err?.stack }, { status: 500 });
  }
}
