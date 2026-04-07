/**
 * Skill 1 — 风险评估
 *
 * 12 个维度的加权打分，0-100 分映射红/黄/绿。
 *
 * 双层结构：
 *  1. 规则引擎（主力）— 80% 的判断由硬规则给出，置信度 100%
 *  2. AI 增强层（可选）— 让 Claude 用自然语言解释 Top 3 风险，失败可降级
 *
 * 风险等级：中（影响业务判断但不动数据）
 * 缓存：6h
 * 默认 shadow（第一周通过 SHADOW_MODE=true 控制）
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';
import { AGENT_FLAGS } from '@/lib/agent/featureFlags';

// ════════════════════════════════════════════════
// 12 维度规则定义
// ════════════════════════════════════════════════

interface RiskDimension {
  id: string;
  category: string;
  label: string;
  /** 此维度的最高加分 */
  maxScore: number;
  /** 检测函数：返回这次实际加分 + 触发原因 */
  evaluate: (ctx: RiskContext) => { score: number; reason?: string };
}

interface RiskContext {
  order: any;
  customer: { totalOrders: number; complaintCount: number; avgDelayDays: number };
  factory: { totalOrders: number; avgDelayDays: number; qcPassRate: number | null };
  milestones: Array<{ step_key: string; status: string; due_at: string | null }>;
  attachments: Array<{ file_type: string }>;
  specialTags: string[];
  hasFile: (t: string) => boolean;
}

const DIMENSIONS: RiskDimension[] = [
  // 1. 客户维度
  {
    id: 'new_customer',
    category: '客户',
    label: '新客户首单',
    maxScore: 20,
    evaluate: ctx => {
      if (ctx.order.is_new_customer || ctx.customer.totalOrders === 0) {
        return { score: 20, reason: '该客户在系统内首单 — 沟通模式 / 付款节奏 / 验货标准都未知' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'customer_complaint_history',
    category: '客户',
    label: '客户历史投诉',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.customer.complaintCount >= 2) {
        return { score: 10, reason: `该客户历史有 ${ctx.customer.complaintCount} 条投诉记录，需高度警惕` };
      }
      if (ctx.customer.complaintCount === 1) {
        return { score: 5, reason: '客户曾投诉过 1 次' };
      }
      return { score: 0 };
    },
  },

  // 2. 工厂维度
  {
    id: 'new_factory',
    category: '工厂',
    label: '新工厂首单',
    maxScore: 15,
    evaluate: ctx => {
      if (ctx.order.is_new_factory || ctx.factory.totalOrders === 0) {
        return { score: 15, reason: '工厂在系统内前 3 单 — 必须提高 QC 频率，建议 100% 检验' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'multi_factory',
    category: '工厂',
    label: '跨厂区生产',
    maxScore: 8,
    evaluate: ctx => {
      const ids = ctx.order.factory_ids;
      if (Array.isArray(ids) && ids.length > 0) {
        return { score: 8, reason: `涉及 ${ids.length + 1} 个厂区，工序衔接 / 质量一致性风险高` };
      }
      return { score: 0 };
    },
  },
  {
    id: 'factory_history_delay',
    category: '工厂',
    label: '工厂历史延期率高',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.factory.avgDelayDays >= 5) {
        return { score: 10, reason: `工厂历史平均延期 ${Math.round(ctx.factory.avgDelayDays)} 天` };
      }
      if (ctx.factory.avgDelayDays >= 2) {
        return { score: 5, reason: `工厂历史平均延期 ${Math.round(ctx.factory.avgDelayDays)} 天` };
      }
      return { score: 0 };
    },
  },

  // 3. 品类维度
  {
    id: 'high_stretch',
    category: '品类',
    label: '高弹面料',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.specialTags.includes('高弹面料')) {
        return { score: 10, reason: '氨纶含量高 → 缩水率 / 单耗超标风险，需提前测缩水' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'plus_size',
    category: '品类',
    label: 'Plus Size',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.specialTags.includes('大码款')) {
        return { score: 10, reason: 'XL 以上 grade 容易出错，建议每个码段单独打样' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'complex_print',
    category: '品类',
    label: '复杂印花',
    maxScore: 5,
    evaluate: ctx => {
      if (ctx.specialTags.includes('复杂印花')) {
        return { score: 5, reason: '满印 / 精细对位 — 印花对色和套位风险' };
      }
      return { score: 0 };
    },
  },

  // 4. 颜色维度
  {
    id: 'light_color',
    category: '颜色',
    label: '浅色风险',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.specialTags.includes('浅色风险')) {
        return { score: 10, reason: '白 / 米 / 浅灰 — 色牢度 / 染色不匀风险，要求工厂提前送样' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'color_clash',
    category: '颜色',
    label: '撞色拼接',
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.specialTags.includes('撞色风险')) {
        return { score: 10, reason: '深浅色拼接 — 沾色风险，必须做色牢度测试' };
      }
      return { score: 0 };
    },
  },

  // 5. 数量维度
  {
    id: 'small_complex',
    category: '数量',
    label: '小单 + 多款多色',
    maxScore: 8,
    evaluate: ctx => {
      const qty = ctx.order.quantity || 0;
      const styles = ctx.order.style_count || 0;
      const colors = ctx.order.color_count || 0;
      if (qty < 500 && styles >= 3 && colors >= 3) {
        return { score: 8, reason: `仅 ${qty} 件分 ${styles} 款 ${colors} 色 — 工艺切换成本高，工厂可能不愿做` };
      }
      return { score: 0 };
    },
  },

  // 6. 交期维度
  {
    id: 'rush_order',
    category: '交期',
    label: '加急订单',
    maxScore: 15,
    evaluate: ctx => {
      const orderDate = ctx.order.order_date ? new Date(ctx.order.order_date) : null;
      const factoryDate = ctx.order.factory_date ? new Date(ctx.order.factory_date) : null;
      if (!orderDate || !factoryDate) return { score: 0 };
      const days = Math.ceil((factoryDate.getTime() - orderDate.getTime()) / 86400000);
      if (days <= 25) {
        return { score: 15, reason: `仅 ${days} 天交期 — 极端紧迫，建议增加 buffer` };
      }
      if (days <= 35) {
        return { score: 8, reason: `${days} 天交期 — 偏紧，跟单需密切跟进` };
      }
      return { score: 0 };
    },
  },
  {
    id: 'tight_deadline_tag',
    category: '交期',
    label: '业务标记交期紧',
    maxScore: 5,
    evaluate: ctx => {
      if (ctx.specialTags.includes('交期紧急')) {
        return { score: 5, reason: '业务在创建时已标记交期紧急' };
      }
      return { score: 0 };
    },
  },
  {
    id: 'peak_season',
    category: '交期',
    label: '跨旺季生产',
    maxScore: 8,
    evaluate: ctx => {
      const factoryDate = ctx.order.factory_date ? new Date(ctx.order.factory_date) : null;
      if (!factoryDate) return { score: 0 };
      const month = factoryDate.getMonth() + 1; // 1-12
      // 9-11 月（圣诞订单旺季 + 工厂超载）+ 1-2 月（春节前后）
      if (month >= 9 && month <= 11) {
        return { score: 8, reason: '跨秋冬旺季（9-11月）— 工厂产能紧张，QC 和物流双高峰' };
      }
      if (month === 1 || month === 2) {
        return { score: 8, reason: '跨春节前后 — 工人短缺 / 节后开工不齐' };
      }
      return { score: 0 };
    },
  },

  // 7. 包装维度
  {
    id: 'custom_packaging',
    category: '包装',
    label: '定制包装',
    maxScore: 8,
    evaluate: ctx => {
      if (ctx.order.packaging_type === 'custom') {
        return { score: 8, reason: '非标准包装 — 必须客户多轮确认，常见拖期点' };
      }
      return { score: 0 };
    },
  },

  // 8. 文件维度
  {
    id: 'critical_files_missing',
    category: '文件',
    label: '关键文件缺失',
    maxScore: 20,
    evaluate: ctx => {
      const missing: string[] = [];
      if (!ctx.hasFile('customer_po')) missing.push('客户 PO');
      if (!ctx.hasFile('internal_quote')) missing.push('内部报价单');
      if (!ctx.hasFile('customer_quote')) missing.push('客户报价单');
      if (missing.length === 0) return { score: 0 };
      const score = Math.min(20, missing.length * 7);
      return { score, reason: `缺关键文件：${missing.join(' / ')}` };
    },
  },

  // 9. 流程维度
  {
    id: 'skip_sample_new_factory',
    category: '流程',
    label: '跳过产前样 + 新工厂',
    maxScore: 25,
    evaluate: ctx => {
      const skipSample = ctx.order.skip_pre_production_sample;
      const newFactory = ctx.order.is_new_factory || ctx.factory.totalOrders === 0;
      if (skipSample && newFactory) {
        return { score: 25, reason: '跳过产前样 + 新工厂 — 极高风险，强烈建议至少做 1 件确认样' };
      }
      if (skipSample) {
        return { score: 8, reason: '跳过产前样 — 老工厂可接受，但首件确认必须严格' };
      }
      return { score: 0 };
    },
  },

  // 10. 历史维度（同客户上单延期）
  {
    id: 'customer_recent_delay',
    category: '历史',
    label: '该客户上单延期',
    maxScore: 12,
    evaluate: ctx => {
      if (ctx.customer.avgDelayDays >= 5) {
        return { score: 12, reason: `该客户最近 5 单平均延期 ${Math.round(ctx.customer.avgDelayDays)} 天` };
      }
      if (ctx.customer.avgDelayDays >= 2) {
        return { score: 6, reason: `该客户历史有轻度延期记录` };
      }
      return { score: 0 };
    },
  },
];

// ════════════════════════════════════════════════
// AI 增强层 — 让 Claude 给 Top 3 风险加自然语言解释
// ════════════════════════════════════════════════

async function enhanceWithAI(
  order: any,
  topFindings: SkillFinding[],
): Promise<{ enhanced: SkillFinding[]; success: boolean }> {
  if (!AGENT_FLAGS.aiEnhance() || topFindings.length === 0) {
    return { enhanced: topFindings, success: false };
  }

  const prompt = `你是一个有 20 年外贸服装订单管理经验的 CEO。
下面是一个订单的简要信息和系统识别出的 Top 风险点。
请用最简练的语言（每条 1 句话，不超过 30 字）给出"该怎么处理"的建议。

订单：${order.order_no || '?'} / 客户 ${order.customer_name || '?'} / 数量 ${order.quantity || '?'} 件

风险点：
${topFindings.map((f, i) => `${i + 1}. [${f.category}] ${f.label} — ${f.detail || ''}`).join('\n')}

返回 JSON：
{
  "advice": [
    { "index": 1, "action": "建议动作（30字内）" },
    { "index": 2, "action": "..." },
    ...
  ]
}
只返回 JSON。`;

  const result = await callClaudeJSON<{ advice: Array<{ index: number; action: string }> }>({
    scene: 'risk_assessment_enhance',
    prompt,
    maxTokens: 500,
    timeoutMs: 20_000,
  });

  if (!result || !Array.isArray(result.advice)) {
    return { enhanced: topFindings, success: false };
  }

  // 把 AI 建议合并到 findings
  const enhanced = topFindings.map((f, i) => {
    const aiSuggest = result.advice.find(a => a.index === i + 1);
    if (aiSuggest && aiSuggest.action) {
      return { ...f, detail: f.detail ? `${f.detail} · ${aiSuggest.action}` : aiSuggest.action };
    }
    return f;
  });

  return { enhanced, success: true };
}

// ════════════════════════════════════════════════
// Skill 主函数
// ════════════════════════════════════════════════

export const riskAssessmentSkill: SkillModule = {
  name: 'risk_assessment',
  displayName: '风险评估',
  cacheTtlMs: 6 * 60 * 60 * 1000, // 6h

  hashInput: (input: SkillInput) => {
    return JSON.stringify({
      orderId: input.orderId,
      version: 'v1',
    });
  },

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) throw new Error('risk_assessment requires orderId');

    // 1. 加载订单 + 关联数据
    const orderRes = await (ctx.supabase.from('orders') as any)
      .select('id, order_no, customer_name, customer_id, factory_id, factory_name, factory_ids, factory_date, etd, warehouse_due_date, quantity, style_count, color_count, incoterm, packaging_type, special_tags, is_new_customer, is_new_factory, skip_pre_production_sample, order_date, lifecycle_status')
      .eq('id', input.orderId)
      .single();

    const order = orderRes.data;
    if (!order) throw new Error('Order not found');

    // 并行加载关联数据
    const [milestonesRes, attachmentsRes, customerStatsRes, factoryStatsRes] = await Promise.all([
      (ctx.supabase.from('milestones') as any)
        .select('step_key, status, due_at')
        .eq('order_id', input.orderId),
      (ctx.supabase.from('order_attachments') as any)
        .select('file_type')
        .eq('order_id', input.orderId),
      // 客户历史：投诉数 + 历史平均延期
      computeCustomerStats(ctx.supabase, order.customer_name),
      // 工厂历史：订单数 + 平均延期
      computeFactoryStats(ctx.supabase, order.factory_id),
    ]);

    const milestones = (milestonesRes.data || []) as any[];
    const attachments = (attachmentsRes.data || []) as Array<{ file_type: string }>;
    const fileSet = new Set(attachments.map(a => a.file_type));
    const specialTags = Array.isArray(order.special_tags) ? order.special_tags : [];

    const riskCtx: RiskContext = {
      order,
      customer: customerStatsRes,
      factory: factoryStatsRes,
      milestones,
      attachments,
      specialTags,
      hasFile: (t: string) => fileSet.has(t),
    };

    // 2. 跑所有维度规则
    const findings: SkillFinding[] = [];
    const dimensionScores: Record<string, number> = {};
    let totalScore = 0;

    for (const dim of DIMENSIONS) {
      try {
        const r = dim.evaluate(riskCtx);
        if (r.score > 0) {
          totalScore += r.score;
          dimensionScores[dim.id] = r.score;
          findings.push({
            category: dim.category,
            severity: r.score >= 15 ? 'high' : r.score >= 8 ? 'medium' : 'low',
            label: dim.label,
            detail: r.reason,
          });
        }
      } catch (err: any) {
        console.error(`[risk_assessment] dimension ${dim.id} failed:`, err?.message);
      }
    }

    // 3. 总分映射等级
    const score = Math.min(100, totalScore);
    let level: 'high' | 'medium' | 'low';
    let summary: string;
    if (score >= 60) {
      level = 'high';
      summary = `🔴 高风险订单 (${score}/100) — Top ${Math.min(3, findings.length)} 风险点见下`;
    } else if (score >= 30) {
      level = 'medium';
      summary = `🟡 中风险订单 (${score}/100) — 需重点关注`;
    } else {
      level = 'low';
      summary = `🟢 低风险订单 (${score}/100) — 按常规流程执行`;
    }

    // 4. 按 score 倒序，取 Top 5
    findings.sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 };
      return order[b.severity] - order[a.severity];
    });
    const topFindings = findings.slice(0, 5);

    // 5. AI 增强（可选，失败不影响）
    const { enhanced, success: aiSuccess } = await enhanceWithAI(order, topFindings.slice(0, 3));
    const finalFindings = [
      ...enhanced,
      ...topFindings.slice(enhanced.length),
    ];

    return {
      severity: level,
      score,
      summary,
      findings: finalFindings,
      suggestions: finalFindings.slice(0, 3).map(f => ({
        action: f.detail || f.label,
        reason: `[${f.category}] ${f.label}`,
      })),
      confidence: aiSuccess ? 90 : 85,
      source: aiSuccess ? 'rules+ai' : 'rules',
      meta: {
        totalScore: score,
        level,
        dimensionScores,
        dimensionsEvaluated: DIMENSIONS.length,
        dimensionsTriggered: Object.keys(dimensionScores).length,
        aiEnhanced: aiSuccess,
      },
    };
  },
};

// ════════════════════════════════════════════════
// 客户 / 工厂 历史统计 helper
// ════════════════════════════════════════════════

async function computeCustomerStats(supabase: any, customerName: string | null) {
  const empty = { totalOrders: 0, complaintCount: 0, avgDelayDays: 0 };
  if (!customerName) return empty;

  try {
    // 历史订单数
    const { count: orderCount } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('customer_name', customerName);

    // 投诉数（从 customer_memory 找 category in ['complaint','quality','delay']）
    let complaintCount = 0;
    try {
      const { count } = await (supabase.from('customer_memory') as any)
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customerName)
        .in('category', ['complaint', 'quality', 'delay']);
      complaintCount = count || 0;
    } catch {}

    // 平均延期：取最近 5 单的逾期天数平均
    let avgDelayDays = 0;
    try {
      const { data: recent } = await (supabase.from('orders') as any)
        .select('id, factory_date')
        .eq('customer_name', customerName)
        .order('created_at', { ascending: false })
        .limit(5);
      if (recent && recent.length > 0) {
        // 简化：用 milestone 是否有 overdue 估算
        const orderIds = recent.map((o: any) => o.id);
        const { data: overdueMs } = await (supabase.from('milestones') as any)
          .select('order_id, due_at, actual_at, status')
          .in('order_id', orderIds);
        const delays: number[] = [];
        for (const m of (overdueMs || [])) {
          if (m.actual_at && m.due_at) {
            const d = (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000;
            if (d > 0) delays.push(d);
          }
        }
        if (delays.length > 0) {
          avgDelayDays = delays.reduce((a, b) => a + b, 0) / delays.length;
        }
      }
    } catch {}

    return {
      totalOrders: orderCount || 0,
      complaintCount,
      avgDelayDays,
    };
  } catch {
    return empty;
  }
}

async function computeFactoryStats(supabase: any, factoryId: string | null) {
  const empty = { totalOrders: 0, avgDelayDays: 0, qcPassRate: null };
  if (!factoryId) return empty;

  try {
    const { count } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('factory_id', factoryId);

    // 工厂表可能已有缓存字段（factories.avg_delay_days / qc_pass_rate）
    let avgDelayDays = 0;
    let qcPassRate: number | null = null;
    try {
      const { data: factory } = await (supabase.from('factories') as any)
        .select('avg_delay_days, qc_pass_rate')
        .eq('id', factoryId)
        .maybeSingle();
      if (factory) {
        avgDelayDays = Number(factory.avg_delay_days) || 0;
        qcPassRate = factory.qc_pass_rate != null ? Number(factory.qc_pass_rate) : null;
      }
    } catch {}

    return {
      totalOrders: count || 0,
      avgDelayDays,
      qcPassRate,
    };
  } catch {
    return empty;
  }
}
