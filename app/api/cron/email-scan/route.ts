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
import { identifyCustomerFromEmail } from '@/lib/agent/customerEmailMapping';
import { extractCommunicationDetails, saveCommunicationDetails } from '@/lib/agent/orderCommunicationLog';
import { generateEmailDraft } from '@/lib/agent/emailDraft';
import { parseEmailForOrderInfo, fetchNewEmails } from '@/lib/utils/imap-fetch';
import { deepCompareEmailWithOrder } from '@/lib/agent/emailOrderCompare';
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

    // ═══ Step 0: 从 IMAP 拉取新邮件写入 mail_inbox ═══
    let fetched = 0;
    let imapStatus = 'skipped';
    let imapError = '';

    const imapUser = process.env.IMAP_USER;
    const imapPass = process.env.IMAP_PASSWORD;

    if (!imapUser || !imapPass) {
      imapStatus = 'no_credentials';
      console.warn('[email-scan] IMAP_USER/IMAP_PASSWORD 未配置');
    } else {
      try {
        console.log(`[email-scan] IMAP 连接 ${imapUser}...`);
        const newEmails = await fetchNewEmails(30, 1); // 拉取最近1天
        imapStatus = `fetched_${newEmails.length}`;
        console.log(`[email-scan] IMAP 拉取到 ${newEmails.length} 封邮件`);

        for (const email of newEmails) {
          const rawFrom = email.from || '';
          const fromEmail = rawFrom.includes('<')
            ? rawFrom.match(/<(.+?)>/)?.[1] || rawFrom
            : rawFrom;
          if (!fromEmail) continue;

          // 去重：同一发件人+同一主题+同一天 只入库一次
          const emailDate = email.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);
          const { data: existing } = await supabase
            .from('mail_inbox')
            .select('id')
            .eq('from_email', fromEmail)
            .eq('subject', email.subject)
            .gte('received_at', `${emailDate}T00:00:00`)
            .lte('received_at', `${emailDate}T23:59:59`)
            .limit(1)
            .maybeSingle();

          if (existing) continue;

          const threadSubject = email.subject
            .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
            .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
            .trim();
          const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

          const { error: insertErr } = await supabase.from('mail_inbox').insert({
            from_email: fromEmail,
            subject: email.subject,
            raw_body: email.body,
            received_at: email.date || new Date().toISOString(),
            message_id: email.messageId,
            in_reply_to: email.inReplyTo,
            thread_id: threadId,
          });
          if (insertErr) {
            console.error('[email-scan] 写入 mail_inbox 失败:', insertErr.message);
          } else {
            fetched++;
          }
        }
      } catch (imapErr: any) {
        imapStatus = 'error';
        imapError = imapErr?.message || 'Unknown IMAP error';
        console.error('[email-scan] IMAP 连接失败:', imapError);
      }
    }

    // 获取未分析的邮件
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: unprocessed } = await supabase
      .from('mail_inbox')
      .select('id, from_email, subject, raw_body, received_at, order_id')
      .is('order_id', null)
      .gte('received_at', oneDayAgo)
      .order('received_at', { ascending: false })
      .limit(30); // 每次最多处理30封

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

      // 1.5 智能客户识别（域名映射 → 历史匹配 → AI识别）
      const customerResult = await identifyCustomerFromEmail(supabase, email.from_email, email.subject, email.raw_body || '');

      // 2. 用 AI 深度分析
      const analysis = await analyzeEmailWithAI(
        email.from_email,
        email.subject,
        email.raw_body || '',
        customerContext,
      );

      // 合并客户识别结果
      const customerName = customerResult.customerName || analysis.customerName || null;
      if (customerResult.customerName) {
        analysis.customerName = customerName;
      }

      // 2.5 邮件线索追踪
      const threadSubject = email.subject
        .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
        .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
        .trim();
      const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

      const { data: existingThread } = await supabase
        .from('mail_inbox').select('id')
        .eq('thread_id', threadId).lt('received_at', email.received_at)
        .limit(1).maybeSingle();

      // ★ 立即保存客户识别+线索（不管是否匹配到订单）
      await supabase.from('mail_inbox')
        .update({
          customer_id: customerName,
          thread_id: threadId,
          is_thread_start: !existingThread,
        })
        .eq('id', email.id)
        .catch(() => {});

      // 3. 匹配订单 — 多策略匹配
      let orderId: string | null = null;
      let orderOwner: string | null = null;

      // 策略A: AI 分析结果 或 规则引擎提取的 PO 号
      let orderNo = analysis.matchedOrderNo || (parsed.poNumbers.length > 0 ? parsed.poNumbers[0] : null);

      // 策略B: 从邮件主题提取纯数字（如 "Re: 531 CAPRIS" → "531"）
      if (!orderNo) {
        const subjectClean = threadSubject.replace(/^#/, '');
        const numMatch = subjectClean.match(/^(\d{2,6})\b/);
        if (numMatch) orderNo = numMatch[1];
      }

      // 策略C: 从主题中找任何 3-6 位数字匹配 po_number
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
        const { data: order } = await supabase
          .from('orders')
          .select('id, order_no, customer_name, quantity, owner_user_id')
          .or(`order_no.eq.${orderNo},po_number.eq.${orderNo}`)
          .limit(1)
          .maybeSingle();
        if (order) {
          orderId = order.id;
          orderOwner = order.owner_user_id;
          await supabase.from('mail_inbox')
            .update({ order_id: order.id, customer_id: customerName || order.customer_name })
            .eq('id', email.id);
          matched++;
          console.log(`[email-scan] 匹配成功: ${email.subject} → ${order.order_no}`);

          // 4. 深度对比邮件 vs 订单数据
          try {
            const compareResult = await deepCompareEmailWithOrder(supabase, {
              subject: email.subject,
              body: email.raw_body || '',
              fromEmail: email.from_email,
              quantityMentioned: analysis.quantityMentioned,
              deliveryMentioned: analysis.deliveryMentioned,
              changes: analysis.changes,
              sampleRelated: analysis.sampleRelated,
            }, order.id);

            if (compareResult.hasDiscrepancy && orderOwner) {
              const discList = compareResult.discrepancies
                .map(d => `• [${d.severity === 'high' ? '严重' : d.severity === 'medium' ? '注意' : '轻微'}] ${d.field}：邮件「${d.emailValue}」vs 系统「${d.orderValue}」\n  → ${d.suggestion}`)
                .join('\n');

              await supabase.from('notifications').insert({
                user_id: orderOwner,
                type: 'email_change_detected',
                title: `🔍 邮件-订单对比发现差异 — ${order.order_no}`,
                message: `${compareResult.summary}\n\n${discList}`,
                related_order_id: order.id,
                status: 'unread',
              });
              alerted++;

              // 高严重度差异推微信
              const highItems = compareResult.discrepancies.filter(d => d.severity === 'high');
              if (highItems.length > 0) {
                const { pushToUsers } = await import('@/lib/utils/wechat-push');
                await pushToUsers(supabase, [orderOwner],
                  `🔍 ${order.order_no} 邮件-订单差异`,
                  `${compareResult.summary}\n${highItems.map(d => `• ${d.field}：${d.suggestion}`).join('\n')}`
                ).catch(() => {});
              }
            }
          } catch (compareErr: any) {
            console.error('[email-scan] Compare error:', compareErr?.message);
            // 降级到简单对比
            if (analysis.changes.length > 0 && orderOwner) {
              const changeDesc = analysis.changes.map(c => `• ${c.description}`).join('\n');
              await supabase.from('notifications').insert({
                user_id: orderOwner,
                type: 'email_change_detected',
                title: `📧 客户邮件检测到变更 — ${order.order_no}`,
                message: `${changeDesc}\n\n建议：${analysis.suggestedAction || '请核实'}`,
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

      // 6.8 提取订单沟通细节（归属到客户+订单，业务员换了也不丢）
      if (analysis.customerName || customerResult.customerName) {
        const custName = analysis.customerName || customerResult.customerName || '';
        const details = await extractCommunicationDetails(email.subject, email.raw_body || '', email.from_email, email.received_at);
        if (details.length > 0) {
          await saveCommunicationDetails(supabase, custName, orderId, details);
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
      imap: { status: imapStatus, error: imapError || undefined, user: imapUser || 'not_set' },
      fetched,
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
