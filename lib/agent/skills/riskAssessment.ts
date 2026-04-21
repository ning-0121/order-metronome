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
import {
  getKnowledgeByTags,
  formatKnowledgeForPrompt,
} from '@/lib/agent/professionalKnowledge';

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
    maxScore: 12,
    evaluate: ctx => {
      // 证据：业务在创建订单时勾选了"新客户首单"标记 OR 系统查到该客户历史订单数=0
      if (ctx.order.is_new_customer === true) {
        return {
          score: 12,
          reason: '该客户在系统内首单 — 沟通模式 / 付款节奏 / 验货标准都未知',
          evidence: '订单字段 is_new_customer = true（业务创建时手动勾选或系统自动检测）',
        };
      }
      if (ctx.customer.totalOrders === 0) {
        return {
          score: 12,
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
    maxScore: 10,
    evaluate: ctx => {
      if (ctx.order.is_new_factory === true) {
        return {
          score: 10,
          reason: '工厂在系统内前 3 单 — 必须提高 QC 频率，建议 100% 检验',
          evidence: '订单字段 is_new_factory = true',
        };
      }
      if (ctx.order.factory_id && ctx.factory.totalOrders === 0) {
        return {
          score: 10,
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
    maxScore: 5,
    evaluate: ctx => {
      const qty = ctx.order.quantity || 0;
      const styles = ctx.order.style_count || 0;
      const colors = ctx.order.color_count || 0;
      if (qty < 500 && styles >= 3 && colors >= 3) {
        return {
          score: 5,
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
    maxScore: 18,
    evaluate: ctx => {
      const orderDate = ctx.order.order_date ? new Date(ctx.order.order_date) : null;
      const factoryDate = ctx.order.factory_date ? new Date(ctx.order.factory_date) : null;
      if (!orderDate || !factoryDate) return { score: 0 };
      const days = Math.ceil((factoryDate.getTime() - orderDate.getTime()) / 86400000);
      if (days <= 25) {
        return {
          score: 18,
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
    maxScore: 5,
    evaluate: ctx => {
      const factoryDate = ctx.order.factory_date ? new Date(ctx.order.factory_date) : null;
      if (!factoryDate) return { score: 0 };
      const month = factoryDate.getMonth() + 1; // 1-12
      if (month >= 9 && month <= 11) {
        return {
          score: 5,
          reason: '跨秋冬旺季（9-11月）— 工厂产能紧张，QC 和物流双高峰',
          evidence: `订单 factory_date=${ctx.order.factory_date}（${month} 月）`,
        };
      }
      if (month === 1 || month === 2) {
        return {
          score: 5,
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
    maxScore: 4,
    evaluate: ctx => {
      if (ctx.order.packaging_type !== 'custom') return { score: 0 };
      return {
        score: 4,
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
    maxScore: 12,
    evaluate: ctx => {
      const missing: string[] = [];
      const isDone = (key: string) => ctx.milestones.some(m => m.step_key === key && (m.status === 'done' || m.status === 'completed'));
      if (!ctx.hasFile('customer_po') && !isDone('po_confirmed')) missing.push('客户 PO');
      if (!ctx.hasFile('internal_quote') && !isDone('finance_approval')) missing.push('内部成本核算单');
      if (!ctx.hasFile('customer_quote') && !isDone('finance_approval')) missing.push('客户报价单');
      if (missing.length === 0) return { score: 0 };
      const score = Math.min(12, missing.length * 4);
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
    maxScore: 30,
    evaluate: ctx => {
      const skipSample = ctx.order.skip_pre_production_sample === true;
      const newFactory = ctx.order.is_new_factory === true || (ctx.order.factory_id && ctx.factory.totalOrders === 0);
      if (skipSample && newFactory) {
        return {
          score: 30,
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

  // 11. 动态交期维度 — 基于"当前剩余天数"和"未完成节点数"
  {
    id: 'deadline_crunch',
    category: '交期',
    label: '出厂倒计时风险',
    maxScore: 25,
    evaluate: ctx => {
      const factoryDate = ctx.order.factory_date ? new Date(ctx.order.factory_date) : null;
      if (!factoryDate) return { score: 0 };
      const now = new Date();
      const remainingDays = Math.ceil((factoryDate.getTime() - now.getTime()) / 86400000);
      if (remainingDays > 14) return { score: 0 }; // 超过 14 天不触发

      const DONE = new Set(['done', '已完成', 'completed']);
      const total = ctx.milestones.length;
      const done = ctx.milestones.filter(m => DONE.has(m.status)).length;
      const remaining = total - done;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;

      if (remainingDays <= 3 && remaining > 2) {
        return {
          score: 25,
          reason: `仅剩 ${remainingDays} 天出厂，还有 ${remaining} 个节点未完成（进度 ${progress}%）— 极高延期风险`,
          evidence: `factory_date=${ctx.order.factory_date}，里程碑 ${done}/${total} 完成`,
        };
      }
      if (remainingDays <= 7 && remaining > 3) {
        return {
          score: 18,
          reason: `剩 ${remainingDays} 天出厂，还有 ${remaining} 个节点未完成（进度 ${progress}%）— 必须加速`,
          evidence: `factory_date=${ctx.order.factory_date}，里程碑 ${done}/${total} 完成`,
        };
      }
      if (remainingDays <= 14 && remaining > 5) {
        return {
          score: 10,
          reason: `剩 ${remainingDays} 天出厂，还有 ${remaining} 个节点未完成（进度 ${progress}%）`,
          evidence: `factory_date=${ctx.order.factory_date}，里程碑 ${done}/${total} 完成`,
        };
      }
      return { score: 0 };
    },
  },

  // 13. 季节性风险（旺季产能紧张）
  {
    id: 'seasonal_risk',
    category: '季节',
    label: '旺季产能风险',
    maxScore: 10,
    evaluate: ctx => {
      // 服装行业旺季：8-10月（秋冬备货）、2-3月（春夏备货+年后复工）
      const etd = ctx.order.etd || ctx.order.factory_date;
      if (!etd) return { score: 0 };
      const month = new Date(etd).getMonth() + 1; // 1-12
      const peakMonths = [8, 9, 10]; // 出厂高峰
      const prepMonths = [2, 3]; // 年后复工+春夏备货
      if (peakMonths.includes(month)) {
        return {
          score: 10,
          reason: `${month}月是出货旺季，工厂产能紧张，交期延误概率增加 30%`,
          evidence: `订单出厂月份=${month}（行业旺季 8-10 月）`,
        };
      }
      if (prepMonths.includes(month)) {
        return {
          score: 6,
          reason: `${month}月年后复工期，工厂招工不稳定，产能恢复慢`,
          evidence: `订单出厂月份=${month}（年后复工 2-3 月）`,
        };
      }
      return { score: 0 };
    },
  },

  // 14. 工厂并行订单负载
  {
    id: 'factory_load',
    category: '工厂',
    label: '工厂并行订单',
    maxScore: 8,
    evaluate: ctx => {
      if (!ctx.factory.totalOrders) return { score: 0 };
      // 同时进行中的订单数（不含已完成的）
      const activeOrders = ctx.factory.totalOrders; // 已经是活跃订单数
      if (activeOrders >= 8) {
        return {
          score: 8,
          reason: `工厂同时有 ${activeOrders} 个活跃订单，产能分配风险高`,
          evidence: `查询该工厂活跃订单数 = ${activeOrders}`,
        };
      }
      if (activeOrders >= 5) {
        return {
          score: 4,
          reason: `工厂同时有 ${activeOrders} 个活跃订单`,
          evidence: `查询该工厂活跃订单数 = ${activeOrders}`,
        };
      }
      return { score: 0 };
    },
  },
];

// ════════════════════════════════════════════════
// AI 叙事层 — 让 Claude 扮演 10 年外贸业务员，把规则输出转成"故事"
// ════════════════════════════════════════════════

interface NarrativePayload {
  /** 一句话：现在最危险的 1 件事 */
  top_concern: string;
  /** 未来 7 天必须解决的事（最多 3 条） */
  week_ahead: Array<{
    title: string;
    reason: string;
    action: string;
    target_role: 'sales' | 'merchandiser' | 'finance' | 'procurement' | 'admin';
  }>;
  /** 需要注意但可以等的事 */
  watch_list: string[];
  /** 业务员判断该订单是否"表面平静实际有坑" */
  hidden_risk_warning: string | null;
}

async function generateBusinessNarrative(
  order: any,
  findings: SkillFinding[],
  milestones: Array<{ step_key: string; status: string; due_at: string | null }>,
  customerStats: { totalOrders: number; avgDelayDays: number; hasEnoughData: boolean },
  factoryStats: { totalOrders: number; avgDelayDays: number; hasEnoughData: boolean },
  supabase: any,
  orderId: string,
): Promise<NarrativePayload | null> {
  if (!AGENT_FLAGS.aiEnhance() || findings.length === 0) return null;

  // 注入和该订单相关的专业知识
  const tags: string[] = ['customer'];
  const specialTags: string[] = Array.isArray(order.special_tags) ? order.special_tags : [];
  if (order.incoterm === 'DDP') tags.push('ddp', 'shipping');
  if (order.incoterm === 'FOB') tags.push('fob');
  if (specialTags.some(t => t.includes('加急'))) tags.push('rush', '加急');
  if (!order.skip_pre_production_sample) tags.push('sample', '打样');
  tags.push('lifecycle', 'payment');
  const knowledge = getKnowledgeByTags(tags, { maxItems: 6 });
  const knowledgeBlock = formatKnowledgeForPrompt(knowledge);

  const systemPrompt = `你是订单节拍器的风险分析引擎。你的工作是把系统检测到的事实数据用简洁的业务语言表达出来。

**核心原则：只说有数据支撑的话，不编造、不猜测、不推测。**

你会收到两类数据：
1. 规则引擎检测到的风险点（每条都有证据）
2. 订单当前进度和经营状态（来自系统实时数据）

**输出要求**：严格输出以下 JSON（不要 markdown 包装）：
{
  "top_concern": "基于数据的一句话总结。格式：'[具体事实] → [具体后果]'。例如：'距出厂仅3天但还有6个节点未完成 → 100%会延期'。如果没有严重问题就说'当前按计划推进中，无紧急风险'",
  "week_ahead": [
    {
      "title": "事项标题（10字内）",
      "reason": "基于什么数据得出的（引用系统数据）",
      "action": "具体动作：谁 + 做什么 + 什么时候前（20字内）",
      "target_role": "sales|merchandiser|finance|procurement|admin"
    }
  ],
  "watch_list": ["基于数据的观察点，不是猜测（每条15字内）"],
  "hidden_risk_warning": null
}

**严格禁止**：
- 禁止说"客户习惯延期X天" — 除非系统数据里明确给了客户历史延期天数
- 禁止说"已收款/未收款" — 除非系统数据里明确标注了收款状态
- 禁止说"建议和客户沟通" — 必须说清楚"沟通什么、谁去沟通、什么时候前"
- 禁止编造任何系统数据里没有的信息
- hidden_risk_warning 永远填 null — 不猜测隐藏风险
- 如果数据不足，直接说"数据不足，无法判断"，不要凑字数
- week_ahead 只列有明确数据支撑的事项，宁少勿编`;

  // 计算当前进度摘要给 AI
  const DONE_STATUSES = new Set(['done', '已完成', 'completed']);
  const ACTIVE_STATUSES = new Set(['in_progress', '进行中']);
  const BLOCKED_STATUSES = new Set(['blocked', '卡单', '卡住']);
  const totalMs = milestones.length;
  const doneMs = milestones.filter((m: any) => DONE_STATUSES.has(m.status)).length;
  const activeMs = milestones.filter((m: any) => ACTIVE_STATUSES.has(m.status));
  const blockedMs = milestones.filter((m: any) => BLOCKED_STATUSES.has(m.status));
  const overdueMs = milestones.filter((m: any) => ACTIVE_STATUSES.has(m.status) && m.due_at && new Date(m.due_at) < new Date());
  const remainingDays = order.factory_date
    ? Math.ceil((new Date(order.factory_date).getTime() - new Date().getTime()) / 86400000)
    : null;

  // 查询经营数据（收款/利润/确认链）
  let bizContext = '';
  try {
    const [finRes, confRes] = await Promise.all([
      (supabase.from('order_financials') as any)
        .select('margin_pct, deposit_status, deposit_amount, balance_status, balance_amount, balance_due_date, payment_hold, allow_production, allow_shipment')
        .eq('order_id', orderId).maybeSingle(),
      (supabase.from('order_confirmations') as any)
        .select('module, status')
        .eq('order_id', orderId),
    ]);
    const fin = finRes.data;
    const confs = confRes.data || [];
    const pendingConfs = confs.filter((c: any) => c.status !== 'confirmed');

    if (fin) {
      const parts = [];
      if (fin.margin_pct !== null) parts.push(`毛利率 ${fin.margin_pct}%${fin.margin_pct < 8 ? '（低于8%底线）' : ''}`);
      else parts.push('毛利率：未录入');

      if (fin.deposit_amount > 0) parts.push(`定金：${fin.deposit_status === 'received' ? '已收' : '未收'}（¥${fin.deposit_amount}）`);
      else parts.push('定金：未设置');

      if (fin.balance_amount > 0) parts.push(`尾款：${fin.balance_status === 'received' ? '已收' : fin.balance_status === 'overdue' ? '已逾期' : '未收'}（¥${fin.balance_amount}）`);
      else parts.push('尾款：未设置');

      if (fin.payment_hold) parts.push('⚠ 付款已暂停');
      if (!fin.allow_production) parts.push('⚠ 生产未放行');
      if (!fin.allow_shipment) parts.push('⚠ 出货未放行');

      bizContext += `\n- 💰 经营状态：${parts.join(' | ')}`;
    }

    if (pendingConfs.length > 0) {
      const labels: Record<string, string> = { fabric_color: '面料颜色', size_breakdown: '尺码配比', logo_print: 'Logo/印花', packaging_label: '包装唛头' };
      bizContext += `\n- ✅ 确认链：${pendingConfs.length} 项未确认（${pendingConfs.map((c: any) => labels[c.module] || c.module).join('、')}）`;
    } else if (confs.length > 0) {
      bizContext += '\n- ✅ 确认链：全部已确认';
    }
  } catch {}

  const userPrompt = `订单信息（全部来自系统实时数据）：
- 订单号 ${order.order_no || '?'}
- 客户 ${order.customer_name || '?'}${order.is_new_customer ? '（新客户首单）' : ''}
- 工厂 ${order.factory_name || '?'}${order.is_new_factory ? '（新工厂）' : ''}
- 数量 ${order.quantity || '?'} 件，${order.style_count || '?'} 款 ${order.color_count || '?'} 色
- 贸易条款 ${order.incoterm || '?'}
- 下单日 ${order.order_date || '?'}，出厂日 ${order.factory_date || '?'}
- ⏱ 距出厂还剩 ${remainingDays !== null ? `${remainingDays} 天` : '未设置'}
- 📊 当前进度：${doneMs}/${totalMs} 完成（${totalMs > 0 ? Math.round(doneMs / totalMs * 100) : 0}%），${activeMs.length} 个进行中${blockedMs.length > 0 ? `，${blockedMs.length} 个卡住` : ''}${overdueMs.length > 0 ? `，${overdueMs.length} 个已逾期` : ''}${bizContext}
- 特殊标签 ${specialTags.length > 0 ? specialTags.join('、') : '无'}
- 客户历史：${customerStats.hasEnoughData ? `${customerStats.totalOrders} 单，平均延期 ${Math.round(customerStats.avgDelayDays)} 天` : '历史数据不足，无法判断'}
- 工厂历史：${factoryStats.hasEnoughData ? `${factoryStats.totalOrders} 单，平均延期 ${Math.round(factoryStats.avgDelayDays)} 天` : '历史数据不足，无法判断'}

**规则引擎已识别的风险点**（按严重度排序）：
${findings
  .slice(0, 10)
  .map(
    (f, i) =>
      `${i + 1}. [${f.severity === 'high' ? '🔴 高' : f.severity === 'medium' ? '🟡 中' : '⚪ 低'}][${f.category}] ${f.label}${f.detail ? ' — ' + f.detail : ''}${f.evidence ? '（证据：' + f.evidence + '）' : ''}`,
  )
  .join('\n')}

请基于以上信息，用业务员视角输出 JSON。`;

  return await callClaudeJSON<NarrativePayload>({
    scene: 'risk_assessment_narrative',
    model: 'claude-sonnet-4-20250514',
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 1500,
    timeoutMs: 35_000,
  });
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
      // v4：业务员视角叙事层 + 专业知识库注入
      version: 'v8-facts-only',
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
    // 修复 BUG：之前 push findings 时丢失了 evidence 字段，导致 UI 看不到证据链
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
            severity: r.score >= 12 ? 'high' : r.score >= 6 ? 'medium' : 'low',
            label: dim.label,
            detail: r.reason,
            evidence: r.evidence,  // ← 关键修复：透传证据
          });
        }
      } catch (err: any) {
        console.error(`[risk_assessment] dimension ${dim.id} failed:`, err?.message);
      }
    }

    // 3. 数据不足检测：如果客户和工厂都是新的，明确告知"数据不足"
    const insufficientNotices: SkillFinding[] = [];
    if (!riskCtx.customer.hasEnoughData && order.customer_name) {
      insufficientNotices.push({
        category: '数据状态',
        severity: 'low',
        label: '客户历史数据不足',
        detail: `该客户在系统内仅 ${riskCtx.customer.totalOrders} 单，无法判断历史投诉/延期表现`,
        evidence: `查询 orders 表：customer_name='${order.customer_name}' 总订单数 = ${riskCtx.customer.totalOrders}（< 3 单基线）`,
      });
    }
    if (!riskCtx.factory.hasEnoughData && order.factory_id) {
      insufficientNotices.push({
        category: '数据状态',
        severity: 'low',
        label: '工厂历史数据不足',
        detail: `该工厂在系统内仅 ${riskCtx.factory.totalOrders} 单，无法判断历史质量/交期表现`,
        evidence: `查询 orders 表：factory_id='${order.factory_id}' 总订单数 = ${riskCtx.factory.totalOrders}（< 3 单基线）`,
      });
    }

    // 4. 总分归一化（所有维度 maxScore 之和 = 229，映射到 0-100）
    const MAX_TOTAL_SCORE = 229;
    const score = Math.round(Math.min(100, (totalScore / MAX_TOTAL_SCORE) * 100));
    let level: 'high' | 'medium' | 'low';
    let summary: string;
    if (score >= 65) {
      level = 'high';
      summary = `🔴 高风险订单 (${score}/100) — 共 ${findings.length} 项风险，重点见下`;
    } else if (score >= 35) {
      level = 'medium';
      summary = `🟡 中风险订单 (${score}/100) — 共 ${findings.length} 项需关注`;
    } else if (findings.length > 0) {
      level = 'low';
      summary = `🟢 低风险订单 (${score}/100) — ${findings.length} 项轻微风险`;
    } else {
      level = 'low';
      summary = `🟢 低风险订单 (${score}/100) — 按常规流程执行，无已识别风险点`;
    }

    // 5. 按严重度倒序
    findings.sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 };
      return order[b.severity] - order[a.severity];
    });
    const topFindings = findings.slice(0, 6);

    // 6. AI 叙事层 — 让业务员视角的 Claude 把规则结果重新组织
    const narrative = await generateBusinessNarrative(
      order,
      findings,
      milestones,
      riskCtx.customer,
      riskCtx.factory,
      ctx.supabase,
      input.orderId,
    );
    const aiSuccess = narrative !== null;

    // 把叙事层的 top_concern / week_ahead / watch_list / hidden_risk_warning
    // 转换成 findings + suggestions，放在规则 findings 前面
    const narrativeFindings: SkillFinding[] = [];
    const narrativeSuggestions: Array<{ action: string; reason: string; targetRole?: string }> = [];

    if (narrative) {
      // AI 输出校验：top_concern 必须引用规则引擎的真实 findings 作为依据
      if (narrative.top_concern) {
        // 从规则引擎 findings 里找最严重的作为依据
        const topRule = topFindings[0];
        const evidenceText = topRule
          ? `依据：[${topRule.category}] ${topRule.label}${topRule.evidence ? '（' + topRule.evidence + '）' : ''}`
          : '⚠ AI 判断，未匹配到规则依据';
        narrativeFindings.push({
          category: '🎯 当前最关键',
          severity: level,
          label: narrative.top_concern,
          evidence: evidenceText,
        });
      }
      for (const wa of narrative.week_ahead || []) {
        narrativeFindings.push({
          category: '⏰ 7 天内要做',
          severity: 'medium',
          label: wa.title,
          detail: `${wa.reason}\n→ ${wa.action}`,
          evidence: '基于规则引擎风险点推导',
          whoShouldFix: wa.target_role,
        });
        narrativeSuggestions.push({
          action: wa.action,
          reason: wa.reason,
          targetRole: wa.target_role,
        });
      }
      // hidden_risk_warning 已禁用 — AI 不允许猜测隐藏风险
      for (const wl of (narrative.watch_list || []).slice(0, 3)) {
        narrativeFindings.push({
          category: '👁 留意',
          severity: 'low',
          label: wl,
        });
      }
    }

    // 最终 findings 顺序：AI 叙事（第一视角）→ 规则原始 Top 3（细节支撑）→ 数据不足提醒
    const finalFindings = narrative
      ? [...narrativeFindings, ...topFindings.slice(0, 3), ...insufficientNotices]
      : [...topFindings, ...insufficientNotices];

    // summary 用叙事层的 top_concern，失败时 fallback 到规则 summary
    const finalSummary = narrative?.top_concern
      ? `${level === 'high' ? '🔴' : level === 'medium' ? '🟡' : '🟢'} ${narrative.top_concern}`
      : summary;

    return {
      severity: level,
      score,
      summary: finalSummary,
      findings: finalFindings,
      suggestions:
        narrativeSuggestions.length > 0
          ? narrativeSuggestions
          : finalFindings
              .filter(f => f.category !== '数据状态')
              .slice(0, 3)
              .map(f => ({
                action: f.detail || f.label,
                reason: `[${f.category}] ${f.label}`,
              })),
      // 置信度反映"可参考的真实数据有多少"
      confidence: (() => {
        let conf = aiSuccess ? 92 : 85;
        if (!riskCtx.customer.hasEnoughData) conf -= 15;
        if (!riskCtx.factory.hasEnoughData) conf -= 10;
        return Math.max(40, conf);
      })(),
      source: aiSuccess ? 'rules+ai' : 'rules',
      meta: {
        totalScore: score,
        level,
        dimensionScores,
        dimensionsEvaluated: DIMENSIONS.length,
        dimensionsTriggered: Object.keys(dimensionScores).length,
        aiEnhanced: aiSuccess,
        narrativeGenerated: narrative !== null,
        customerDataSufficient: riskCtx.customer.hasEnoughData,
        factoryDataSufficient: riskCtx.factory.hasEnoughData,
        customerTotalOrders: riskCtx.customer.totalOrders,
        factoryTotalOrders: riskCtx.factory.totalOrders,
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
