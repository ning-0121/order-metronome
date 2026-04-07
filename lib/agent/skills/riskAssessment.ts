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
  /**
   * 检测函数：返回 score + reason + evidence
   * 重要：evidence 必须是真实数据源描述，例如「customer_memory 表 1 条 complaint 类型记录」
   * 没有真实数据时必须返回 score: 0，绝不"凭感觉"加分
   */
  evaluate: (ctx: RiskContext) => { score: number; reason?: string; evidence?: string };
}

interface RiskContext {
  order: any;
  customer: {
    totalOrders: number;
    complaintCount: number;
    qualityIssueCount: number;
    avgDelayDays: number;
    hasEnoughData: boolean; // 是否有足够订单数据可参考（≥3 单）
  };
  factory: {
    totalOrders: number;
    avgDelayDays: number;
    qcPassRate: number | null;
    hasEnoughData: boolean;
  };
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
      // 证据：业务在创建订单时勾选了"新客户首单"标记 OR 系统查到该客户历史订单数=0
      if (ctx.order.is_new_customer === true) {
        return {
          score: 20,
          reason: '该客户在系统内首单 — 沟通模式 / 付款节奏 / 验货标准都未知',
          evidence: '订单字段 is_new_customer = true（业务创建时手动勾选或系统自动检测）',
        };
      }
      if (ctx.customer.totalOrders === 0) {
        return {
          score: 20,
          reason: '该客户在系统内首单',
          evidence: `查询 orders 表：customer_name='${ctx.order.customer_name}' 历史订单数 = 0`,
        };
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
      // 证据：必须真的有 complaint / quality 类的 customer_memory 记录
      // 严格区分：delay 类型的记录是延期申请，不是投诉
      // 新客户（首单）逻辑上不可能有投诉，必须先排除
      if (ctx.order.is_new_customer === true || ctx.customer.totalOrders === 0) {
        return { score: 0 };
      }
      const total = ctx.customer.complaintCount + ctx.customer.qualityIssueCount;
      if (total === 0) {
        return { score: 0 };
      }
      if (total >= 2) {
        return {
          score: 10,
          reason: `该客户有 ${ctx.customer.complaintCount} 条投诉 + ${ctx.customer.qualityIssueCount} 条质量问题记录`,
          evidence: `customer_memory 表：category IN ('complaint','quality') 共 ${total} 条`,
        };
      }
      return {
        score: 5,
        reason: `客户有 ${total} 条投诉/质量问题记录`,
        evidence: `customer_memory 表：category IN ('complaint','quality') 共 ${total} 条`,
      };
    },
  },

  // 2. 工厂维度
  {
    id: 'new_factory',
    category: '工厂',
    label: '新工厂首单',
    maxScore: 15,
    evaluate: ctx => {
      if (ctx.order.is_new_factory === true) {
        return {
          score: 15,
          reason: '工厂在系统内前 3 单 — 必须提高 QC 频率，建议 100% 检验',
          evidence: '订单字段 is_new_factory = true',
        };
      }
      if (ctx.order.factory_id && ctx.factory.totalOrders === 0) {
        return {
          score: 15,
          reason: '工厂在系统内首单 — 必须提高 QC 频率',
          evidence: `查询 orders 表：factory_id='${ctx.order.factory_id}' 历史订单数 = 0`,
        };
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
        return {
          score: 8,
          reason: `涉及 ${ids.length + 1} 个厂区，工序衔接 / 质量一致性风险高`,
          evidence: `订单字段 factory_ids = [${ids.length} 个额外厂区]`,
        };
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
      // 必须有足够的历史数据才能下结论 — 至少 3 单
      if (!ctx.factory.hasEnoughData) return { score: 0 };
      if (ctx.factory.avgDelayDays >= 5) {
        return {
          score: 10,
          reason: `工厂历史平均延期 ${Math.round(ctx.factory.avgDelayDays)} 天`,
          evidence: `factories 表 avg_delay_days = ${ctx.factory.avgDelayDays}（基于 ${ctx.factory.totalOrders} 单）`,
        };
      }
      if (ctx.factory.avgDelayDays >= 2) {
        return {
          score: 5,
          reason: `工厂历史平均延期 ${Math.round(ctx.factory.avgDelayDays)} 天`,
          evidence: `factories 表 avg_delay_days = ${ctx.factory.avgDelayDays}（基于 ${ctx.factory.totalOrders} 单）`,
        };
      }
      return { score: 0 };
    },
  },

  // 3. 品类维度（特殊标签 = 业务在创建订单时勾选的，证据明确）
  {
    id: 'high_stretch',
    category: '品类',
    label: '高弹面料',
    maxScore: 10,
    evaluate: ctx => {
      if (!ctx.specialTags.includes('高弹面料')) return { score: 0 };
      return {
        score: 10,
        reason: '氨纶含量高 → 缩水率 / 单耗超标风险，需提前测缩水',
        evidence: '订单创建时业务勾选了「高弹面料」标签',
      };
    },
  },
  {
    id: 'plus_size',
    category: '品类',
    label: 'Plus Size',
    maxScore: 10,
    evaluate: ctx => {
      if (!ctx.specialTags.includes('大码款')) return { score: 0 };
      return {
        score: 10,
        reason: 'XL 以上 grade 容易出错，建议每个码段单独打样',
        evidence: '订单创建时业务勾选了「大码款」标签',
      };
    },
  },
  {
    id: 'complex_print',
    category: '品类',
    label: '复杂印花',
    maxScore: 5,
    evaluate: ctx => {
      if (!ctx.specialTags.includes('复杂印花')) return { score: 0 };
      return {
        score: 5,
        reason: '满印 / 精细对位 — 印花对色和套位风险',
        evidence: '订单创建时业务勾选了「复杂印花」标签',
      };
    },
  },

  // 4. 颜色维度
  {
    id: 'light_color',
    category: '颜色',
    label: '浅色风险',
    maxScore: 10,
    evaluate: ctx => {
      if (!ctx.specialTags.includes('浅色风险')) return { score: 0 };
      return {
        score: 10,
        reason: '白 / 米 / 浅灰 — 色牢度 / 染色不匀风险，要求工厂提前送样',
        evidence: '订单创建时业务勾选了「浅色风险」标签',
      };
    },
  },
  {
    id: 'color_clash',
    category: '颜色',
    label: '撞色拼接',
    maxScore: 10,
    evaluate: ctx => {
      if (!ctx.specialTags.includes('撞色风险')) return { score: 0 };
      return {
        score: 10,
        reason: '深浅色拼接 — 沾色风险，必须做色牢度测试',
        evidence: '订单创建时业务勾选了「撞色风险」标签',
      };
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
        return {
          score: 8,
          reason: `仅 ${qty} 件分 ${styles} 款 ${colors} 色 — 工艺切换成本高，工厂可能不愿做`,
          evidence: `订单字段 quantity=${qty} / style_count=${styles} / color_count=${colors}`,
        };
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
        return {
          score: 15,
          reason: `仅 ${days} 天交期 — 极端紧迫，建议增加 buffer`,
          evidence: `订单字段：order_date=${ctx.order.order_date} → factory_date=${ctx.order.factory_date}（${days} 天）`,
        };
      }
      if (days <= 35) {
        return {
          score: 8,
          reason: `${days} 天交期 — 偏紧，跟单需密切跟进`,
          evidence: `订单字段：order_date=${ctx.order.order_date} → factory_date=${ctx.order.factory_date}（${days} 天）`,
        };
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
      if (!ctx.specialTags.includes('交期紧急')) return { score: 0 };
      return {
        score: 5,
        reason: '业务在创建时已标记交期紧急',
        evidence: '订单创建时业务勾选了「交期紧急」标签',
      };
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
      if (month >= 9 && month <= 11) {
        return {
          score: 8,
          reason: '跨秋冬旺季（9-11月）— 工厂产能紧张，QC 和物流双高峰',
          evidence: `订单 factory_date=${ctx.order.factory_date}（${month} 月）`,
        };
      }
      if (month === 1 || month === 2) {
        return {
          score: 8,
          reason: '跨春节前后 — 工人短缺 / 节后开工不齐',
          evidence: `订单 factory_date=${ctx.order.factory_date}（${month} 月，春节区间）`,
        };
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
      if (ctx.order.packaging_type !== 'custom') return { score: 0 };
      return {
        score: 8,
        reason: '非标准包装 — 必须客户多轮确认，常见拖期点',
        evidence: '订单字段 packaging_type = "custom"',
      };
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
      return {
        score,
        reason: `缺关键文件：${missing.join(' / ')}`,
        evidence: `查 order_attachments 表：${missing.length} 个 file_type 缺失`,
      };
    },
  },

  // 9. 流程维度
  {
    id: 'skip_sample_new_factory',
    category: '流程',
    label: '跳过产前样 + 新工厂',
    maxScore: 25,
    evaluate: ctx => {
      const skipSample = ctx.order.skip_pre_production_sample === true;
      const newFactory = ctx.order.is_new_factory === true || (ctx.order.factory_id && ctx.factory.totalOrders === 0);
      if (skipSample && newFactory) {
        return {
          score: 25,
          reason: '跳过产前样 + 新工厂 — 极高风险，强烈建议至少做 1 件确认样',
          evidence: 'skip_pre_production_sample=true 且 is_new_factory=true',
        };
      }
      if (skipSample) {
        return {
          score: 8,
          reason: '跳过产前样 — 老工厂可接受，但首件确认必须严格',
          evidence: '订单字段 skip_pre_production_sample = true',
        };
      }
      return { score: 0 };
    },
  },

  // 10. 历史维度（同客户上单延期）— 必须有足够数据才能下结论
  {
    id: 'customer_recent_delay',
    category: '历史',
    label: '该客户上单延期',
    maxScore: 12,
    evaluate: ctx => {
      // 必须至少有 3 单历史，否则无意义
      if (!ctx.customer.hasEnoughData) return { score: 0 };
      if (ctx.customer.avgDelayDays >= 5) {
        return {
          score: 12,
          reason: `该客户最近订单平均延期 ${Math.round(ctx.customer.avgDelayDays)} 天`,
          evidence: `基于 ${ctx.customer.totalOrders} 单历史里程碑数据计算`,
        };
      }
      if (ctx.customer.avgDelayDays >= 2) {
        return {
          score: 6,
          reason: `该客户历史有轻度延期记录（平均 ${Math.round(ctx.customer.avgDelayDays)} 天）`,
          evidence: `基于 ${ctx.customer.totalOrders} 单历史里程碑数据计算`,
        };
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
  const empty = {
    totalOrders: 0,
    complaintCount: 0,
    qualityIssueCount: 0,
    avgDelayDays: 0,
    hasEnoughData: false,
  };
  if (!customerName) return empty;

  try {
    // 历史订单数
    const { count: orderCount } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('customer_name', customerName);
    const totalOrders = orderCount || 0;

    // 投诉数（仅 category='complaint'，不算 delay/general）
    let complaintCount = 0;
    let qualityIssueCount = 0;
    try {
      const { count: cc } = await (supabase.from('customer_memory') as any)
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customerName)
        .eq('category', 'complaint');
      complaintCount = cc || 0;

      const { count: qc } = await (supabase.from('customer_memory') as any)
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customerName)
        .eq('category', 'quality');
      qualityIssueCount = qc || 0;
    } catch {}

    // 平均延期：必须有 ≥3 单 + ≥3 条 actual_at 数据才能可信
    let avgDelayDays = 0;
    try {
      if (totalOrders >= 3) {
        const { data: recent } = await (supabase.from('orders') as any)
          .select('id')
          .eq('customer_name', customerName)
          .order('created_at', { ascending: false })
          .limit(5);
        if (recent && recent.length > 0) {
          const orderIds = recent.map((o: any) => o.id);
          const { data: doneMs } = await (supabase.from('milestones') as any)
            .select('order_id, due_at, actual_at')
            .in('order_id', orderIds)
            .not('actual_at', 'is', null);
          const delays: number[] = [];
          for (const m of (doneMs || [])) {
            if (m.actual_at && m.due_at) {
              const d = (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000;
              if (d > 0) delays.push(d);
            }
          }
          // 至少 3 个真实数据点才计算平均
          if (delays.length >= 3) {
            avgDelayDays = delays.reduce((a, b) => a + b, 0) / delays.length;
          }
        }
      }
    } catch {}

    return {
      totalOrders,
      complaintCount,
      qualityIssueCount,
      avgDelayDays,
      // 至少 3 单才算"足够数据"做历史分析
      hasEnoughData: totalOrders >= 3,
    };
  } catch {
    return empty;
  }
}

async function computeFactoryStats(supabase: any, factoryId: string | null) {
  const empty = { totalOrders: 0, avgDelayDays: 0, qcPassRate: null, hasEnoughData: false };
  if (!factoryId) return empty;

  try {
    const { count } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('factory_id', factoryId);
    const totalOrders = count || 0;

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
      totalOrders,
      avgDelayDays,
      qcPassRate,
      // 至少 3 单才算"足够数据"做历史分析
      hasEnoughData: totalOrders >= 3,
    };
  } catch {
    return empty;
  }
}
