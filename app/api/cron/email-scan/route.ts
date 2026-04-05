/**
 * 邮件扫描 Cron — 每15分钟检查新邮件
 *
 * 两种模式：
 * 1. 被动模式（推荐）：腾讯企邮自动转发到 /api/mail-inbox，本 cron 负责 AI 分析
 * 2. 主动模式：通过 Google Apps Script 中转拉取
 *
 * 本 cron 的职责：
 * - 扫描 mail_inbox 表中未分析的邮件
 * - AI 分析邮件内容，提取订单信息
 * - 对比现有订单，检查遗漏/误读
 * - 通知业务员
 */

import { createClient } from '@supabase/supabase-js';
import { parseEmailForOrderInfo } from '@/lib/utils/imap-fetch';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

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

    // 获取未分析的邮件（最近24小时，未关联订单的）
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: unprocessed } = await supabase
      .from('mail_inbox')
      .select('id, from_email, subject, raw_body, received_at, order_id, extracted_po')
      .is('order_id', null)
      .gte('received_at', oneDayAgo)
      .order('received_at', { ascending: false })
      .limit(20);

    if (!unprocessed || unprocessed.length === 0) {
      return NextResponse.json({ success: true, processed: 0 });
    }

    let matched = 0;
    let alerted = 0;

    for (const email of unprocessed) {
      const parsed = parseEmailForOrderInfo(email.subject, email.raw_body || '');

      // 尝试匹配现有订单
      for (const po of parsed.poNumbers) {
        const { data: order } = await supabase
          .from('orders')
          .select('id, order_no, customer_name, quantity, owner_user_id')
          .or(`order_no.eq.${po},po_number.eq.${po}`)
          .limit(1)
          .maybeSingle();

        if (order) {
          // 关联邮件到订单
          await supabase.from('mail_inbox')
            .update({ order_id: order.id, customer_id: order.customer_name })
            .eq('id', email.id);
          matched++;

          // 检查数量差异
          if (parsed.quantities.length > 0 && order.quantity) {
            for (const qty of parsed.quantities) {
              if (Math.abs(qty - order.quantity) > order.quantity * 0.1) {
                // 数量差异 >10%，通知业务员
                if (order.owner_user_id) {
                  await supabase.from('notifications').insert({
                    user_id: order.owner_user_id,
                    type: 'email_alert',
                    title: `📧 邮件数量与订单不一致`,
                    message: `邮件中提到 ${qty} 件，但订单 ${order.order_no} 数量为 ${order.quantity} 件。请核实。\n邮件主题：${email.subject}`,
                    related_order_id: order.id,
                    status: 'unread',
                  });
                  alerted++;
                }
              }
            }
          }

          // 紧急邮件通知
          if (parsed.urgentKeywords.length > 0 && order.owner_user_id) {
            await supabase.from('notifications').insert({
              user_id: order.owner_user_id,
              type: 'email_urgent',
              title: `🚨 客户紧急邮件 — ${order.order_no}`,
              message: `客户邮件包含紧急关键词(${parsed.urgentKeywords.join('/')})。\n主题：${email.subject}`,
              related_order_id: order.id,
              status: 'unread',
            });
            alerted++;
          }

          break; // 一封邮件只匹配一个订单
        }
      }
    }

    return NextResponse.json({
      success: true,
      processed: unprocessed.length,
      matched,
      alerted,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
