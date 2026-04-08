/**
 * Skill 2 — 缺失资料检查
 *
 * 纯规则 Skill，不调用 AI。检查订单当前阶段缺失的：
 *  1. 必传文件（按 file_type）
 *  2. 必填字段（订单表）
 *  3. 必须确认的里程碑前置项
 *
 * 输出按"还有几天卡死该节点"排序，业务员一眼看到最紧迫的问题。
 *
 * 风险等级：低（只读，无副作用，纯 SQL 查询）
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';
import { sha256Hex } from './runner';

/**
 * 缺失项规则表 — CEO 拍板的硬规则
 *
 * 每条规则定义：
 *  - check: 检查函数
 *  - blocksStep: 缺失会卡哪个节点
 *  - severity: 严重度
 */
interface MissingRule {
  id: string;
  category: 'file' | 'info' | 'confirmation';
  label: string;
  blocksStep: string;
  blocksStepName: string;
  severity: 'high' | 'medium' | 'low';
  whoShouldFix: 'sales' | 'merchandiser' | 'finance' | 'procurement' | 'admin';
  /** 检查是否缺失（true = 缺失） */
  isMissing: (ctx: OrderContext) => boolean;
  suggestion: (ctx: OrderContext) => string;
  /**
   * 紧迫窗口（天）— 可选
   * 如果设置，则：
   *   - daysToBlocker > urgentWithin*2 → severity 降为 'low'（仅提醒）
   *   - urgentWithin < daysToBlocker ≤ urgentWithin*2 → severity 降为 'medium'
   *   - daysToBlocker ≤ urgentWithin → 保持原 severity
   * 不设置则始终用原 severity。
   */
  urgentWithin?: number;
}

interface OrderContext {
  order: any;
  attachments: Array<{ file_type: string }>;
  milestones: Array<{ step_key: string; status: string; due_at: string | null; checklist_data?: any }>;
  hasFile: (fileType: string) => boolean;
  isStepDone: (stepKey: string) => boolean;
  isStepActive: (stepKey: string) => boolean;
  daysUntilStep: (stepKey: string) => number | null;
}

const RULES: MissingRule[] = [
  // ════════ 文件类规则 ════════
  {
    id: 'missing_customer_po',
    category: 'file',
    label: '客户 PO 文件',
    blocksStep: 'po_confirmed',
    blocksStepName: 'PO确认',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('customer_po'),
    suggestion: () => '联系客户索要正式 PO 文件',
  },
  {
    id: 'missing_internal_quote',
    category: 'file',
    label: '内部报价单',
    blocksStep: 'finance_approval',
    blocksStepName: '财务审核',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('internal_quote'),
    suggestion: () => '上传内部报价单（含加工费/面料/辅料/包装/物流明细）',
  },
  {
    id: 'missing_customer_quote',
    category: 'file',
    label: '客户最终报价单',
    blocksStep: 'finance_approval',
    blocksStepName: '财务审核',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('customer_quote'),
    suggestion: () => '上传我们发给客户的最终报价单',
  },
  {
    id: 'missing_production_order',
    category: 'file',
    label: '生产订单（Production Sheet）',
    blocksStep: 'production_order_upload',
    blocksStepName: '生产单上传',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('production_order') && !ctx.isStepDone('production_order_upload'),
    suggestion: () => '上传生产订单（可由 AI 生成或手动制作）',
  },
  {
    id: 'missing_trims_sheet',
    category: 'file',
    label: '原辅料单',
    blocksStep: 'production_order_upload',
    blocksStepName: '生产单上传',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('trims_sheet') && !ctx.isStepDone('production_order_upload'),
    suggestion: () => '上传原辅料单（面料/纽扣/拉链/线/标签等明细）',
  },
  {
    id: 'missing_packing_requirement',
    category: 'file',
    label: '包装资料',
    blocksStep: 'packing_method_confirmed',
    blocksStepName: '包装方式确认',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx =>
      !ctx.hasFile('packing_requirement') && !ctx.isStepDone('packing_method_confirmed'),
    suggestion: () => '上传包装资料（袋型/纸卡/吊牌/shipping mark）',
    urgentWithin: 10, // 包装前 10 天还没确认才算严重
  },
  {
    id: 'missing_tech_pack',
    category: 'file',
    label: 'Tech Pack（工艺单）',
    blocksStep: 'pre_production_sample_ready',
    blocksStepName: '产前样准备完成',
    severity: 'medium',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.hasFile('tech_pack') && !ctx.isStepDone('pre_production_sample_ready'),
    suggestion: () => '上传客户提供的 Tech Pack（含尺寸表、工艺要求、面料规格）',
    urgentWithin: 5, // 产前样准备前 5 天还没交就算严重
  },
  {
    id: 'missing_qc_report_mid',
    category: 'file',
    label: '中查 QC 报告',
    blocksStep: 'mid_qc_check',
    blocksStepName: '跟单中查',
    severity: 'high',
    whoShouldFix: 'merchandiser',
    isMissing: ctx => ctx.isStepActive('mid_qc_check') && !ctx.hasFile('qc_report'),
    suggestion: () => '中查阶段缺 QC 报告，工厂或第三方需提交',
    // 中查阶段已经进入 in_progress 才会触发，不需要 urgentWithin
  },
  {
    id: 'missing_qc_report_final',
    category: 'file',
    label: '尾查 QC 报告',
    blocksStep: 'final_qc_check',
    blocksStepName: '跟单尾查',
    severity: 'high',
    whoShouldFix: 'merchandiser',
    isMissing: ctx => ctx.isStepActive('final_qc_check') && !ctx.hasFile('qc_report'),
    suggestion: () => '尾查必须有 QC 报告才能放行',
  },
  {
    id: 'missing_packing_list',
    category: 'file',
    label: '装箱单（Packing List）',
    blocksStep: 'booking_done',
    blocksStepName: '订舱完成',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => ctx.isStepActive('booking_done') && !ctx.hasFile('packing_list'),
    suggestion: () => '订舱前必须出装箱单',
  },

  // ════════ 信息字段类规则 ════════
  {
    id: 'missing_factory',
    category: 'info',
    label: '生产工厂',
    blocksStep: 'factory_confirmed',
    blocksStepName: '工厂匹配确认',
    severity: 'high',
    whoShouldFix: 'merchandiser',
    isMissing: ctx => !ctx.order.factory_id && !ctx.order.factory_name,
    suggestion: () => '订单还未指定工厂，跟单需确认',
  },
  {
    id: 'missing_factory_date',
    category: 'info',
    label: '出厂日期',
    blocksStep: 'production_kickoff',
    blocksStepName: '生产启动/开裁',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.order.factory_date,
    suggestion: () => '订单未填出厂日期，影响整个排期',
  },
  {
    id: 'missing_etd_for_ddp',
    category: 'info',
    label: 'ETD（DDP 订单）',
    blocksStep: 'booking_done',
    blocksStepName: '订舱完成',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => ctx.order.incoterm === 'DDP' && !ctx.order.etd,
    suggestion: () => 'DDP 订单必须填 ETD（离港日）',
  },
  {
    id: 'missing_eta_for_ddp',
    category: 'info',
    label: 'ETA / 到仓日（DDP 订单）',
    blocksStep: 'shipment_execute',
    blocksStepName: '出运',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => ctx.order.incoterm === 'DDP' && !ctx.order.warehouse_due_date,
    suggestion: () => 'DDP 订单必须填 ETA（到港 / 到仓日）',
  },
  {
    id: 'missing_quantity',
    category: 'info',
    label: '订单数量',
    blocksStep: 'po_confirmed',
    blocksStepName: 'PO确认',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.order.quantity || ctx.order.quantity <= 0,
    suggestion: () => '订单数量未填或为零',
  },
  {
    id: 'missing_style_count',
    category: 'info',
    label: '款数 / 颜色数',
    blocksStep: 'order_kickoff_meeting',
    blocksStepName: '订单评审会',
    severity: 'medium',
    whoShouldFix: 'sales',
    isMissing: ctx => !ctx.order.style_count || !ctx.order.color_count,
    suggestion: () => '款数 / 颜色数未填，影响产能评估',
  },

  // ════════ 确认类规则 ════════
  {
    id: 'missing_pre_production_sample_approval',
    category: 'confirmation',
    label: '产前样客户确认',
    blocksStep: 'production_kickoff',
    blocksStepName: '生产启动/开裁',
    severity: 'high',
    whoShouldFix: 'sales',
    isMissing: ctx =>
      !ctx.order.skip_pre_production_sample &&
      !ctx.isStepDone('pre_production_sample_approved') &&
      ctx.daysUntilStep('production_kickoff') !== null &&
      ctx.daysUntilStep('production_kickoff')! <= 5,
    suggestion: () => '生产启动前 5 天，产前样还没获得客户确认 — 立即催客户',
  },
  {
    id: 'missing_bulk_materials_confirmed',
    category: 'confirmation',
    label: '大货面料确认',
    blocksStep: 'procurement_order_placed',
    blocksStepName: '采购订单下达',
    severity: 'high',
    whoShouldFix: 'merchandiser',
    isMissing: ctx =>
      !ctx.isStepDone('bulk_materials_confirmed') &&
      ctx.daysUntilStep('procurement_order_placed') !== null &&
      ctx.daysUntilStep('procurement_order_placed')! <= 3,
    suggestion: () => '采购下单前 3 天，大货面料还没确认 — 跟单立即跟进',
  },
];

/**
 * 计算订单到某个里程碑还有几天
 */
function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

export const missingInfoSkill: SkillModule = {
  name: 'missing_info',
  displayName: '缺失资料检查',
  cacheTtlMs: 5 * 60 * 1000, // 5 分钟

  hashInput: (input: SkillInput) => {
    // 同步版本：用简单的字符串拼接代替 sha256（足够区分）
    return JSON.stringify({
      orderId: input.orderId,
      // version 用于规则更新时强制失效旧缓存
      version: 'v2-urgentWithin',
    });
  },

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) {
      throw new Error('missing_info skill requires orderId');
    }

    // 加载订单 + 附件 + 里程碑
    const [orderRes, attachmentsRes, milestonesRes] = await Promise.all([
      (ctx.supabase.from('orders') as any)
        .select('id, order_no, customer_name, factory_id, factory_name, factory_date, etd, warehouse_due_date, quantity, style_count, color_count, incoterm, skip_pre_production_sample, lifecycle_status')
        .eq('id', input.orderId)
        .single(),
      (ctx.supabase.from('order_attachments') as any)
        .select('file_type')
        .eq('order_id', input.orderId),
      (ctx.supabase.from('milestones') as any)
        .select('step_key, status, due_at, checklist_data')
        .eq('order_id', input.orderId)
        .order('due_at', { ascending: true }),
    ]);

    const order = orderRes.data;
    if (!order) throw new Error('Order not found');

    const attachments = (attachmentsRes.data || []) as Array<{ file_type: string }>;
    const milestones = (milestonesRes.data || []) as Array<any>;

    // 构建 OrderContext 给规则用
    const fileTypeSet = new Set(attachments.map(a => a.file_type));
    const milestoneMap = new Map(milestones.map(m => [m.step_key, m]));
    const now = new Date();

    const orderCtx: OrderContext = {
      order,
      attachments,
      milestones,
      hasFile: (fileType: string) => fileTypeSet.has(fileType),
      isStepDone: (stepKey: string) => {
        const m = milestoneMap.get(stepKey);
        if (!m) return false;
        const s = String(m.status || '').toLowerCase();
        return s === 'done' || s === '已完成';
      },
      isStepActive: (stepKey: string) => {
        const m = milestoneMap.get(stepKey);
        if (!m) return false;
        const s = String(m.status || '').toLowerCase();
        return s === 'in_progress' || s === '进行中';
      },
      daysUntilStep: (stepKey: string) => {
        const m = milestoneMap.get(stepKey);
        if (!m || !m.due_at) return null;
        return daysBetween(now, new Date(m.due_at));
      },
    };

    // 根据 urgentWithin 动态降级 severity — 距离卡死节点还远时只算提醒
    function applyUrgency(
      base: 'high' | 'medium' | 'low',
      urgentWithin: number | undefined,
      days: number | null,
    ): 'high' | 'medium' | 'low' {
      if (!urgentWithin || days === null) return base;
      if (days > urgentWithin * 2) return 'low';
      if (days > urgentWithin) return base === 'high' ? 'medium' : 'low';
      return base;
    }

    // 跑所有规则
    const findings: SkillFinding[] = [];
    for (const rule of RULES) {
      try {
        if (rule.isMissing(orderCtx)) {
          const stepDays = orderCtx.daysUntilStep(rule.blocksStep);
          const effectiveSeverity = applyUrgency(rule.severity, rule.urgentWithin, stepDays);
          findings.push({
            category: rule.category,
            severity: effectiveSeverity,
            label: rule.label,
            detail: rule.suggestion(orderCtx),
            blocksStep: rule.blocksStep,
            blocksStepName: rule.blocksStepName,
            daysToBlocker: stepDays !== null ? stepDays : undefined,
            whoShouldFix: rule.whoShouldFix,
          });
        }
      } catch (err: any) {
        // 单条规则失败不影响其他
        console.error(`[missing_info] rule ${rule.id} failed:`, err?.message);
      }
    }

    // 按"距离卡死天数"升序排序（最紧迫的在前）
    findings.sort((a, b) => {
      const aDays = a.daysToBlocker ?? 999;
      const bDays = b.daysToBlocker ?? 999;
      return aDays - bDays;
    });

    // 用动态降级后的 severity 统计（不是原始 rule.severity）
    const blockingCount = findings.filter(f => f.severity === 'high').length;
    const totalCount = findings.length;

    // 生成总体严重度
    let severity: 'high' | 'medium' | 'low' = 'low';
    if (blockingCount > 0) severity = 'high';
    else if (totalCount > 0) severity = 'medium';

    // 总结文案
    let summary: string;
    if (totalCount === 0) {
      summary = '✓ 当前阶段所有必需资料齐全';
    } else if (blockingCount > 0) {
      summary = `${blockingCount} 项关键资料缺失，会卡住生产`;
    } else {
      summary = `${totalCount} 项资料待补充`;
    }

    return {
      severity,
      score: Math.min(100, totalCount * 10 + blockingCount * 15),
      summary,
      findings,
      suggestions: findings.slice(0, 3).map(f => ({
        action: f.detail || f.label,
        reason: `卡 ${f.blocksStepName}` + (f.daysToBlocker !== undefined ? `（剩 ${f.daysToBlocker} 天）` : ''),
        targetRole: f.whoShouldFix,
      })),
      confidence: 100, // 纯规则，置信度 100%
      source: 'rules',
      meta: {
        totalCount,
        blockingCount,
        rulesEvaluated: RULES.length,
      },
    };
  },
};
