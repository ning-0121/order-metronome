/**
 * 邮件扫描 Cron — 每15分钟
 *
 * 1. 扫描 mail_inbox 中未分析的邮件
 * 2. AI 智能匹配客户和订单（不依赖PO号）
 * 3. 检测数量/交期/要求变更
 * 4. 通知业务员差异和遗漏
 */

import { createClient } from '@supabase/supabase-js';
import { analyzeEmailWithAI, buildCustomerContext } from '@/lib/agent/emailMatcher';
import { generateEmailDraft } from '@/lib/agent/emailDraft';
import { parseEmailForOrderInfo } from '@/lib/utils/imap-fetch';
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

    // 获取未分析的邮件
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: unprocessed } = await supabase
      .from('mail_inbox')
      .select('id, from_email, subject, raw_body, received_at, order_id')
      .is('order_id', null)
      .gte('received_at', oneDayAgo)
      .order('received_at', { ascending: false })
      .limit(10); // 每次最多处理10封，控制AI费用

    if (!unprocessed || unprocessed.length === 0) {
      return NextResponse.json({ success: true, processed: 0 });
    }

    // 构建客户和订单上下文（一次查询，所有邮件共用）
    const customerContext = await buildCustomerContext(supabase);

    let matched = 0;
    let alerted = 0;

    for (const email of unprocessed) {
      // 1. 先用规则引擎快速提取
      const parsed = parseEmailForOrderInfo(email.subject, email.raw_body || '');

      // 2. 用 AI 深度分析
      const analysis = await analyzeEmailWithAI(
        email.from_email,
        email.subject,
        email.raw_body || '',
        customerContext,
      );

      // 3. 匹配订单
      let orderId: string | null = null;
      let orderOwner: string | null = null;
      const orderNo = analysis.matchedOrderNo || (parsed.poNumbers.length > 0 ? parsed.poNumbers[0] : null);

      if (orderNo) {
        const { data: order } = await supabase
          .from('orders')
          .select('id, order_no, customer_name, quantity, owner_user_id')
          .or(`order_no.eq.${orderNo},po_number.eq.${orderNo}`)
          .limit(1)
          .maybeSingle();
        if (order) {
          orderId = order.id;
          orderOwner = order.owner_user_id;

          // 更新邮件关联
          await supabase.from('mail_inbox')
            .update({ order_id: order.id, customer_id: analysis.customerName || order.customer_name })
            .eq('id', email.id);
          matched++;

          // 4. 检测变更并通知
          if (analysis.changes.length > 0 && orderOwner) {
            const changeDesc = analysis.changes.map(c => `• ${c.description}`).join('\n');
            await supabase.from('notifications').insert({
              user_id: orderOwner,
              type: 'email_change_detected',
              title: `📧 客户邮件检测到变更 — ${order.order_no}`,
              message: `${analysis.customerName || '客户'}的邮件中发现以下变更：\n${changeDesc}\n\n建议：${analysis.suggestedAction || '请核实'}`,
              related_order_id: order.id,
              status: 'unread',
            });
            alerted++;
          }

          // 数量差异检测
          if (analysis.quantityMentioned && order.quantity) {
            const diff = Math.abs(analysis.quantityMentioned - order.quantity);
            if (diff > order.quantity * 0.05) { // 差异>5%
              await supabase.from('notifications').insert({
                user_id: orderOwner,
                type: 'email_qty_mismatch',
                title: `⚠️ 邮件数量与订单不一致 — ${order.order_no}`,
                message: `邮件提到 ${analysis.quantityMentioned} 件，订单为 ${order.quantity} 件（差异 ${diff} 件）。\n邮件主题：${email.subject}`,
                related_order_id: order.id,
                status: 'unread',
              });
              alerted++;
            }
          }
        }
      }

      // 5. 紧急邮件通知（即使未匹配到订单）
      if (analysis.urgentLevel === 'urgent') {
        // 找到客户对应的业务员
        if (analysis.customerName) {
          const { data: custOrder } = await supabase
            .from('orders')
            .select('owner_user_id')
            .eq('customer_name', analysis.customerName)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (custOrder?.owner_user_id) {
            await supabase.from('notifications').insert({
              user_id: custOrder.owner_user_id,
              type: 'email_urgent',
              title: `🚨 客户紧急邮件 — ${analysis.customerName}`,
              message: `主题：${email.subject}\n${analysis.suggestedAction || '请尽快回复'}`,
              related_order_id: orderId,
              status: 'unread',
            });
            alerted++;
          }
        }
      }

      // 6. 样品相关邮件
      if (analysis.sampleRelated && analysis.customerName) {
        const { data: sampleOrder } = await supabase
          .from('orders')
          .select('id, owner_user_id')
          .eq('customer_name', analysis.customerName)
          .eq('order_purpose', 'sample')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (sampleOrder?.owner_user_id) {
          await supabase.from('notifications').insert({
            user_id: sampleOrder.owner_user_id,
            type: 'email_sample',
            title: `🧪 客户样品邮件 — ${analysis.customerName}`,
            message: `${analysis.suggestedAction || '客户关于样品有新回复，请查看'}`,
            related_order_id: sampleOrder.id,
            status: 'unread',
          });
        }
      }

      // 6.5 生成回复草稿（需要回复的邮件：有变更/紧急/样品反馈）
      if ((analysis.changes.length > 0 || analysis.urgentLevel !== 'normal' || analysis.sampleRelated) && orderOwner) {
        const draft = await generateEmailDraft(supabase,
          { from: email.from_email, subject: email.subject, body: email.raw_body || '' },
          orderId, analysis.customerName,
        );
        if (draft) {
          await supabase.from('notifications').insert({
            user_id: orderOwner,
            type: 'email_draft',
            title: `✉️ AI已草拟回复 — ${email.subject}`,
            message: `回复要点：${draft.keyPoints.join('、')}\n\n草稿：\n${draft.body.slice(0, 300)}...`,
            related_order_id: orderId,
            status: 'unread',
          }).catch(() => {});
        }
      }

      // 7. 写入客户记忆
      if (analysis.customerName && analysis.changes.length > 0) {
        await supabase.from('customer_memory').insert({
          customer_id: analysis.customerName,
          order_id: orderId,
          source_type: 'email_ai',
          content: `邮件分析：${analysis.changes.map(c => c.description).join('；')}`,
          category: analysis.sampleRelated ? 'sample' : 'general',
          risk_level: analysis.urgentLevel === 'urgent' ? 'high' : 'low',
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      success: true,
      processed: unprocessed.length,
      matched,
      alerted,
    });
  } catch (err: any) {
    console.error('[email-scan]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
