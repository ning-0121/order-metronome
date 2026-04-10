/**
 * Skill 4 — 客户邮件洞察
 *
 * 扫描该订单对应客户最近 30 天的邮件，让 Claude 扮演 10 年外贸业务员，输出：
 *  1. 客户最近在关注什么（1 句话）
 *  2. 哪些问题/请求我方还没回复（可能被忽略的）
 *  3. 建议下一封该发的邮件草稿（主题 + 3 条要点）
 *
 * 数据源：mail_inbox 表
 * 风险等级：中（只读，但输出会影响业务员行动）
 * 缓存：2 小时
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';
import {
  getKnowledgeByTags,
  formatKnowledgeForPrompt,
} from '@/lib/agent/professionalKnowledge';

interface InsightsPayload {
  recent_focus: string;
  ignored_requests: Array<{
    received_at: string;
    subject: string;
    quote: string;
    severity: 'high' | 'medium' | 'low';
    suggestion: string;
  }>;
  next_email: {
    subject: string;
    key_points: string[];
    tone: string;
  } | null;
  confidence: number;
}

export const customerEmailInsightsSkill: SkillModule = {
  name: 'customer_email_insights',
  displayName: '客户邮件洞察',
  cacheTtlMs: 2 * 60 * 60 * 1000, // 2h

  hashInput: (input: SkillInput) =>
    JSON.stringify({ orderId: input.orderId, version: 'v3-90days' }),

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) throw new Error('customer_email_insights requires orderId');

    // 1. 拿订单 → 客户名
    const { data: order } = await (ctx.supabase.from('orders') as any)
      .select('id, order_no, customer_name, owner_user_id, incoterm, factory_date')
      .eq('id', input.orderId)
      .single();
    if (!order) throw new Error('Order not found');

    const customerName = order.customer_name;
    if (!customerName) {
      return emptyResult('订单未关联客户，无法分析邮件');
    }

    // 2. 拉取最近 90 天该客户邮件（先按客户名匹配，兜底按该订单的 order_id）
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const { data: mails } = await (ctx.supabase.from('mail_inbox') as any)
      .select('id, from_email, subject, raw_body, received_at, processing_status, order_id')
      .or(`customer_id.eq.${customerName},order_id.eq.${input.orderId}`)
      .gte('received_at', since)
      .order('received_at', { ascending: false })
      .limit(50);

    const emails = (mails || []) as any[];
    if (emails.length === 0) {
      return emptyResult(`最近 90 天没有 ${customerName} 的邮件记录`);
    }

    // 3. 拼装邮件摘要给 AI（节省 tokens — 每封最多 800 字正文）
    const emailDigest = emails
      .map((m, i) => {
        const body = (m.raw_body || '').slice(0, 1200).replace(/\s+/g, ' ').trim();
        return `#${i + 1} [${String(m.received_at).slice(0, 10)}] From: ${m.from_email}\nSubject: ${m.subject}\nBody: ${body}`;
      })
      .join('\n\n---\n\n');

    // 4. 注入相关专业知识（客户行为 + 邮件应对经验）
    const knowledge = getKnowledgeByTags(
      ['customer', 'email', 'urgent', 'silent', '催单'],
      { maxItems: 5 },
    );
    const knowledgeBlock = formatKnowledgeForPrompt(knowledge);

    // 5. 让 Claude 扮演业务员做分析
    const systemPrompt = `你是一个 10 年经验的外贸服装业务员。你正在帮同事分析一个订单关联客户最近的邮件往来，目的是：
1. 识别"客户在关注什么"—— 用 1 句话概括主题
2. 找出"我方可能忽略的问题/请求"—— 特别是数量变更、颜色变更、交期催促、样品问题
3. 建议"下一封该发的邮件"—— 主题 + 3 条要点 + 语气建议

**专业经验参考**：
${knowledgeBlock}

**输出格式**：严格输出以下 JSON（不要 markdown 包装）：
{
  "recent_focus": "1 句话说客户最近在关注什么",
  "ignored_requests": [
    {
      "received_at": "YYYY-MM-DD",
      "subject": "原邮件主题（截断到 50 字）",
      "quote": "原文关键片段（中文/英文都可，50 字以内）",
      "severity": "high|medium|low",
      "suggestion": "我方该怎么回（1 句话）"
    }
  ],
  "next_email": {
    "subject": "建议的下一封邮件主题",
    "key_points": ["要点1", "要点2", "要点3"],
    "tone": "语气描述（专业/温和/略急/商业/友好）"
  },
  "confidence": 0-100
}

**判断规则**：
- ignored_requests 最多 5 条，按重要度排序
- 如果邮件里全都是你已经回复过的，ignored_requests 给空数组 []
- 如果邮件太少（<3 封）或内容都不涉及这个订单，next_email 给 null
- severity：涉及数量/交期/付款 → high；涉及颜色/工艺/面料 → medium；寒暄/确认 → low
- 如果无法确定请求是否被我方忽略（比如只有客户单方邮件、没有上下文），severity 标为 low 而非 medium
- 不要编造邮件里没说的事，宁可漏报也不要误报`;

    const userPrompt = `订单号：${order.order_no}
客户：${customerName}
贸易条款：${order.incoterm}
出厂日：${order.factory_date || '未填'}

**最近 90 天邮件（${emails.length} 封，从新到旧）**：

${emailDigest}`;

    const aiResult = await callClaudeJSON<InsightsPayload>({
      scene: 'customer-email-insights',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 2048,
      timeoutMs: 40_000,
      system: systemPrompt,
      prompt: userPrompt,
    });

    if (!aiResult) {
      return {
        severity: 'low',
        summary: 'AI 分析失败，稍后重试',
        findings: [],
        suggestions: [],
        confidence: 0,
        source: 'rules',
      };
    }

    // 6. 映射到 SkillResult
    const findings: SkillFinding[] = (aiResult.ignored_requests || []).map(r => ({
      category: '被忽略的客户请求',
      severity: r.severity || 'medium',
      label: r.subject,
      detail: `${r.quote}\n→ 建议：${r.suggestion}`,
      evidence: `mail_inbox 表：${r.received_at} 该客户邮件`,
      whoShouldFix: 'sales',
    }));

    // next_email 作为 suggestion 输出
    const suggestions = aiResult.next_email
      ? [
          {
            action: `发送邮件：${aiResult.next_email.subject}`,
            reason: `要点：${(aiResult.next_email.key_points || []).join(' / ')}（语气：${aiResult.next_email.tone}）`,
            targetRole: 'sales',
          },
        ]
      : [];

    const highCount = findings.filter(f => f.severity === 'high').length;
    const severity: 'high' | 'medium' | 'low' =
      highCount > 0 ? 'high' : findings.length > 0 ? 'medium' : 'low';

    const summary = aiResult.recent_focus ||
      (findings.length === 0
        ? '✓ 客户邮件最近没有未处理的请求'
        : `${findings.length} 条可能被忽略的客户请求`);

    return {
      severity,
      summary,
      findings,
      suggestions,
      confidence: Math.min(85, aiResult.confidence ?? 80),
      source: 'rules+ai',
      meta: {
        emailsAnalyzed: emails.length,
        ignoredCount: findings.length,
      },
    };
  },
};

function emptyResult(summary: string): SkillResult {
  return {
    severity: 'low',
    summary,
    findings: [],
    suggestions: [],
    confidence: 0,
    source: 'rules',
  };
}
