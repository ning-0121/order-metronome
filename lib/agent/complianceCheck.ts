/**
 * 邮件-订单执行对照检查
 *
 * 8种场景检测业务员「该做没做」的事：
 * 1. PO确认但未建单
 * 2. 数量不一致未修正
 * 3. 交期变更未更新
 * 4. 客户投诉未处理
 * 5. 样品反馈未更新
 * 6. 紧急邮件未回复
 * 7. 重要要求未记录
 * 8. 客户修改未执行
 */

import { AGENT_FLAGS } from './featureFlags';

export interface ComplianceFinding {
  findingType: string;
  mailInboxId: string | null;
  orderId: string | null;
  customerName: string | null;
  salespersonUserId: string | null;
  title: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  emailDate: string | null;
  daysSinceEmail: number;
  dedupKey: string;
}

/**
 * 运行所有对照检查（每日 cron 调用）
 */
export async function runComplianceChecks(supabase: any): Promise<{
  findings: ComplianceFinding[];
  inserted: number;
  notified: number;
}> {
  if (!AGENT_FLAGS.complianceCheck()) {
    return { findings: [], inserted: 0, notified: 0 };
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const now = new Date();

  // 获取近7天所有邮件（含AI分析结果）
  const { data: emails } = await supabase
    .from('mail_inbox')
    .select('id, from_email, subject, raw_body, received_at, customer_id, order_id, thread_id')
    .gte('received_at', sevenDaysAgo)
    .order('received_at', { ascending: false })
    .limit(200);

  // 获取所有活跃订单
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, quantity, factory_date, etd, lifecycle_status, owner_user_id, sample_status, updated_at')
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效', 'draft'])
    .limit(200);

  // 获取客户记忆（近7天）
  const { data: memories } = await supabase
    .from('customer_memory')
    .select('customer_id, content, source_type, content_json, created_at')
    .gte('created_at', sevenDaysAgo)
    .limit(500);

  // 获取已存在的 open findings（去重用）
  const { data: existingFindings } = await supabase
    .from('compliance_findings')
    .select('dedup_key')
    .eq('status', 'open');

  const existingKeys = new Set((existingFindings || []).map((f: any) => f.dedup_key));

  const allFindings: ComplianceFinding[] = [];

  // ═══ 检查1：紧急邮件未回复 ═══
  const urgentFindings = checkUrgentUnanswered(emails || [], now);
  allFindings.push(...urgentFindings);

  // ═══ 检查2：数量不一致未修正 ═══
  const qtyFindings = checkQuantityMismatchStale(emails || [], orders || [], memories || []);
  allFindings.push(...qtyFindings);

  // ═══ 检查3：客户投诉未处理 ═══
  const complaintFindings = checkComplaintNotAddressed(memories || [], orders || [], now);
  allFindings.push(...complaintFindings);

  // ═══ 检查4：样品反馈未更新 ═══
  const sampleFindings = checkSampleFeedbackNotUpdated(memories || [], orders || []);
  allFindings.push(...sampleFindings);

  // ═══ 用 AI 做批量深度对照 ═══
  const aiFindings = await runAIComplianceCheck(supabase, emails || [], orders || [], memories || []);
  allFindings.push(...aiFindings);

  // 去重并写入
  let inserted = 0;
  let notified = 0;

  for (const f of allFindings) {
    if (existingKeys.has(f.dedupKey)) continue;

    const { error } = await supabase.from('compliance_findings').insert({
      finding_type: f.findingType,
      mail_inbox_id: f.mailInboxId,
      order_id: f.orderId,
      customer_name: f.customerName,
      salesperson_user_id: f.salespersonUserId,
      title: f.title,
      description: f.description,
      severity: f.severity,
      email_date: f.emailDate,
      days_since_email: f.daysSinceEmail,
      dedup_key: f.dedupKey,
    });
    if (!error) {
      inserted++;
      existingKeys.add(f.dedupKey);

      // 通知业务员
      if (f.salespersonUserId) {
        await supabase.from('notifications').insert({
          user_id: f.salespersonUserId,
          type: 'compliance_alert',
          title: f.title,
          message: f.description,
          related_order_id: f.orderId,
          status: 'unread',
        });
        notified++;
      }

      // 高严重度同时通知管理员
      if (f.severity === 'high') {
        const { data: admins } = await supabase.from('profiles').select('user_id').or("role.eq.admin,roles.cs.{admin}");
        for (const admin of admins || []) {
          await supabase.from('notifications').insert({
            user_id: admin.user_id,
            type: 'compliance_alert',
            title: `🔍 业务执行偏差 — ${f.title}`,
            message: f.description,
            related_order_id: f.orderId,
            status: 'unread',
          });
        }
      }
    }
  }

  return { findings: allFindings, inserted, notified };
}

/**
 * 检查：紧急邮件24h+未回复
 */
function checkUrgentUnanswered(emails: any[], now: Date): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600000);

  // 找紧急邮件（主题含urgent/asap/immediately/紧急）
  const urgentKeywords = /urgent|asap|immediately|rush|紧急|加急|尽快/i;
  const urgentEmails = emails.filter(e =>
    !e.from_email?.includes('@qimoclothing.com') &&
    (urgentKeywords.test(e.subject) || urgentKeywords.test(e.raw_body?.slice(0, 500) || '')) &&
    new Date(e.received_at) < twentyFourHoursAgo
  );

  for (const email of urgentEmails) {
    // 检查同一线索是否有我方回复
    const hasReply = emails.some(e =>
      e.from_email?.includes('@qimoclothing.com') &&
      e.thread_id === email.thread_id &&
      new Date(e.received_at) > new Date(email.received_at)
    );

    if (!hasReply) {
      const daysSince = Math.floor((now.getTime() - new Date(email.received_at).getTime()) / 86400000);
      findings.push({
        findingType: 'urgent_unanswered',
        mailInboxId: email.id,
        orderId: email.order_id,
        customerName: email.customer_id,
        salespersonUserId: null, // 后续通过订单归属补全
        title: `紧急邮件 ${daysSince} 天未回复`,
        description: `${email.from_email} 发来紧急邮件「${email.subject}」已 ${daysSince} 天未回复`,
        severity: daysSince >= 3 ? 'high' : 'medium',
        emailDate: email.received_at,
        daysSinceEmail: daysSince,
        dedupKey: `urgent_unanswered:${email.id}`,
      });
    }
  }

  return findings;
}

/**
 * 检查：数量不一致已告警但未修正
 */
function checkQuantityMismatchStale(emails: any[], orders: any[], memories: any[]): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];

  // 找到邮件中提到数量的（从客户记忆中查找数量相关记录）
  const qtyMemories = memories.filter((m: any) =>
    m.source_type === 'email_ai' &&
    m.content?.includes('数量')
  );

  for (const mem of qtyMemories) {
    const order = orders.find((o: any) => o.id === mem.order_id || o.customer_name === mem.customer_id);
    if (!order) continue;

    // 检查该订单数量是否在记忆创建后有更新
    if (order.updated_at && new Date(order.updated_at) > new Date(mem.created_at)) continue;

    const daysSince = Math.floor((Date.now() - new Date(mem.created_at).getTime()) / 86400000);
    if (daysSince < 2) continue; // 2天内不告警

    findings.push({
      findingType: 'quantity_mismatch_stale',
      mailInboxId: null,
      orderId: order.id,
      customerName: order.customer_name,
      salespersonUserId: order.owner_user_id,
      title: `数量差异未修正 — ${order.order_no}`,
      description: `${daysSince} 天前发现邮件数量与订单不一致，至今订单未更新`,
      severity: daysSince >= 5 ? 'high' : 'medium',
      emailDate: mem.created_at,
      daysSinceEmail: daysSince,
      dedupKey: `qty_stale:${order.id}:${mem.created_at?.slice(0, 10)}`,
    });
  }

  return findings;
}

/**
 * 检查：客户投诉48h未处理
 */
function checkComplaintNotAddressed(memories: any[], orders: any[], now: Date): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 3600000);

  const complaints = memories.filter((m: any) =>
    m.source_type === 'email_communication' &&
    m.content_json?.type === 'complaint' &&
    new Date(m.created_at) < fortyEightHoursAgo
  );

  for (const complaint of complaints) {
    // 检查投诉后是否有跟进
    const hasFollowUp = memories.some((m: any) =>
      m.customer_id === complaint.customer_id &&
      (m.content_json?.type === 'confirmation' || m.content_json?.type === 'change') &&
      new Date(m.created_at) > new Date(complaint.created_at)
    );

    if (hasFollowUp) continue;

    const order = orders.find((o: any) => o.customer_name === complaint.customer_id);
    const daysSince = Math.floor((now.getTime() - new Date(complaint.created_at).getTime()) / 86400000);

    findings.push({
      findingType: 'complaint_not_addressed',
      mailInboxId: null,
      orderId: order?.id || null,
      customerName: complaint.customer_id,
      salespersonUserId: order?.owner_user_id || null,
      title: `客户投诉 ${daysSince} 天未处理 — ${complaint.customer_id}`,
      description: `${complaint.content?.slice(0, 100)}`,
      severity: 'high',
      emailDate: complaint.created_at,
      daysSinceEmail: daysSince,
      dedupKey: `complaint:${complaint.id}`,
    });
  }

  return findings;
}

/**
 * 检查：样品反馈未更新状态
 */
function checkSampleFeedbackNotUpdated(memories: any[], orders: any[]): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];

  const sampleFeedbacks = memories.filter((m: any) =>
    m.source_type === 'email_communication' &&
    m.content_json?.type === 'sample' &&
    m.content_json?.importance === 'high'
  );

  for (const fb of sampleFeedbacks) {
    const sampleOrder = orders.find((o: any) =>
      o.customer_name === fb.customer_id &&
      (o.sample_status === 'pending' || o.sample_status === 'in_progress' || !o.sample_status)
    );

    if (!sampleOrder) continue;

    const daysSince = Math.floor((Date.now() - new Date(fb.created_at).getTime()) / 86400000);
    if (daysSince < 2) continue;

    findings.push({
      findingType: 'sample_feedback_not_updated',
      mailInboxId: null,
      orderId: sampleOrder.id,
      customerName: fb.customer_id,
      salespersonUserId: sampleOrder.owner_user_id,
      title: `样品反馈未处理 — ${sampleOrder.order_no}`,
      description: `${daysSince} 天前客户发来样品反馈，但样品状态未更新`,
      severity: daysSince >= 5 ? 'high' : 'medium',
      emailDate: fb.created_at,
      daysSinceEmail: daysSince,
      dedupKey: `sample:${sampleOrder.id}:${fb.created_at?.slice(0, 10)}`,
    });
  }

  return findings;
}

/**
 * AI 批量对照（每个业务员一次调用）
 * 检测：PO确认未建单、交期变更未更新、修改未执行、要求未记录
 */
async function runAIComplianceCheck(
  supabase: any,
  emails: any[],
  orders: any[],
  memories: any[],
): Promise<ComplianceFinding[]> {
  const findings: ComplianceFinding[] = [];

  // 按业务员分组
  const salesOwners = new Map<string, { orders: any[]; emails: any[] }>();

  for (const order of orders) {
    if (!order.owner_user_id) continue;
    const existing = salesOwners.get(order.owner_user_id) || { orders: [], emails: [] };
    existing.orders.push(order);
    salesOwners.set(order.owner_user_id, existing);
  }

  // 将邮件归属到业务员（通过客户名匹配）
  for (const email of emails) {
    if (email.from_email?.includes('@qimoclothing.com')) continue;
    if (!email.customer_id) continue;

    for (const [userId, data] of salesOwners) {
      if (data.orders.some((o: any) => o.customer_name === email.customer_id)) {
        data.emails.push(email);
        break;
      }
    }
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    for (const [userId, data] of salesOwners) {
      if (data.emails.length === 0) continue;

      // 构建对照上下文（限制长度）
      const emailSummary = data.emails.slice(0, 20).map((e: any) =>
        `${e.received_at?.slice(0, 10)} | ${e.from_email} | ${e.subject}`
      ).join('\n');

      const orderSummary = data.orders.slice(0, 10).map((o: any) =>
        `${o.order_no} | ${o.customer_name} | ${o.quantity || '?'}件 | 交期:${o.factory_date || o.etd || '?'} | 状态:${o.lifecycle_status} | 样品:${o.sample_status || '无'}`
      ).join('\n');

      const customerMemories = memories
        .filter((m: any) => data.orders.some((o: any) => o.customer_name === m.customer_id))
        .slice(0, 20)
        .map((m: any) => `${m.created_at?.slice(0, 10)} | ${m.customer_id} | ${m.content?.slice(0, 80)}`)
        .join('\n');

      const prompt = `你是外贸服装订单管理系统的执行合规审计员。对比以下邮件和系统数据，找出业务员「该做没做」的问题。

## 近7天客户邮件：
${emailSummary}

## 系统中的订单：
${orderSummary}

## 客户记忆（已记录的沟通内容）：
${customerMemories || '暂无'}

请检查以下场景，返回JSON数组：
1. po_confirmed_no_order — 邮件中客户确认了PO/下单意向，但系统没有对应新订单
2. delivery_date_not_updated — 邮件中客户提到的交期与系统中不一致
3. modification_not_applied — 邮件中客户要求修改（颜色/尺码/数量等），但系统无变更记录
4. requirements_not_documented — 邮件中客户提出重要要求，但客户记忆中未记录

返回格式：
[{"type":"...","mailSubject":"触发邮件主题","mailDate":"日期","description":"具体问题","severity":"high/medium/low","customerName":"客户名","orderNo":"关联订单号或null"}]

如果一切正常没有问题，返回空数组 []
只返回JSON数组。`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        for (const item of parsed) {
          const order = orders.find((o: any) => o.order_no === item.orderNo || o.customer_name === item.customerName);
          findings.push({
            findingType: item.type || 'modification_not_applied',
            mailInboxId: null,
            orderId: order?.id || null,
            customerName: item.customerName || null,
            salespersonUserId: userId,
            title: `${typeLabels[item.type] || item.type} — ${item.customerName || ''}`,
            description: item.description || '',
            severity: item.severity || 'medium',
            emailDate: item.mailDate || null,
            daysSinceEmail: item.mailDate ? Math.floor((Date.now() - new Date(item.mailDate).getTime()) / 86400000) : 0,
            dedupKey: `ai:${item.type}:${userId}:${item.mailSubject?.slice(0, 30)}`,
          });
        }
      }
    }
  } catch (err) {
    console.error('[compliance-check] AI error:', err);
  }

  return findings;
}

const typeLabels: Record<string, string> = {
  po_confirmed_no_order: '📋 PO确认未建单',
  quantity_mismatch_stale: '🔢 数量差异未修正',
  delivery_date_not_updated: '📅 交期变更未更新',
  complaint_not_addressed: '⚠️ 客户投诉未处理',
  sample_feedback_not_updated: '🧪 样品反馈未更新',
  urgent_unanswered: '🚨 紧急邮件未回复',
  requirements_not_documented: '📝 重要要求未记录',
  modification_not_applied: '🔄 客户修改未执行',
};
