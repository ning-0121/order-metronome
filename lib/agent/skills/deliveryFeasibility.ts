/**
 * Skill 5 — 交期可行性分析
 *
 * 新建订单时自动判断："这个交期能不能做到？"
 *
 * 数据来源：
 *   1. 同品类历史订单的实际生产周期（从 production_kickoff 到 factory_completion）
 *   2. 当前工厂在手订单负荷
 *   3. 专业知识库里的时间常数
 *
 * 输出：
 *   - 可行性：🟢 可行 / 🟡 紧张 / 🔴 极高风险
 *   - 建议最晚下单日
 *   - 类似订单历史实际用了多少天
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';

export const deliveryFeasibilitySkill: SkillModule = {
  name: 'delay_prediction',
  displayName: '交期可行性分析',
  cacheTtlMs: 30 * 60 * 1000, // 30min

  hashInput: (input: SkillInput) =>
    JSON.stringify({ orderId: input.orderId, version: 'v1' }),

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) throw new Error('需要 orderId');

    const { data: order } = await (ctx.supabase.from('orders') as any)
      .select('id, order_no, customer_name, factory_name, factory_id, order_date, factory_date, etd, incoterm, quantity, order_type')
      .eq('id', input.orderId)
      .single();
    if (!order) throw new Error('订单不存在');

    const findings: SkillFinding[] = [];
    const now = new Date();

    // 1. 计算可用天数
    const orderDate = order.order_date ? new Date(order.order_date + 'T00:00:00+08:00') : now;
    const anchor = order.factory_date
      ? new Date(order.factory_date + 'T00:00:00+08:00')
      : order.etd
        ? new Date(order.etd + 'T00:00:00+08:00')
        : null;

    if (!anchor) {
      return {
        severity: 'medium',
        summary: '⚠ 缺少出厂日/交期，无法分析可行性',
        findings: [{ category: '数据缺失', severity: 'medium', label: '请先填写出厂日期或 ETD' }],
        suggestions: [],
        confidence: 0,
        source: 'rules',
      };
    }

    const availableDays = Math.ceil((anchor.getTime() - orderDate.getTime()) / 86400000);
    const remainingDays = Math.ceil((anchor.getTime() - now.getTime()) / 86400000);

    // 2. 查同工厂/同品类历史实际周期
    let historicalDays: number[] = [];
    try {
      const { data: historicalOrders } = await (ctx.supabase.from('orders') as any)
        .select('id')
        .eq('factory_name', order.factory_name)
        .in('lifecycle_status', ['completed', '已完成'])
        .order('created_at', { ascending: false })
        .limit(20);

      if (historicalOrders && historicalOrders.length > 0) {
        const orderIds = (historicalOrders as any[]).map(o => o.id);
        const { data: kickoffs } = await (ctx.supabase.from('milestones') as any)
          .select('order_id, step_key, actual_at')
          .in('order_id', orderIds)
          .in('step_key', ['po_confirmed', 'factory_completion'])
          .not('actual_at', 'is', null);

        // 配对：同一订单的 po_confirmed → factory_completion
        const byOrder: Record<string, { start?: string; end?: string }> = {};
        for (const m of (kickoffs || []) as any[]) {
          if (!byOrder[m.order_id]) byOrder[m.order_id] = {};
          if (m.step_key === 'po_confirmed') byOrder[m.order_id].start = m.actual_at;
          if (m.step_key === 'factory_completion') byOrder[m.order_id].end = m.actual_at;
        }

        for (const [, dates] of Object.entries(byOrder)) {
          if (dates.start && dates.end) {
            const days = Math.ceil((new Date(dates.end).getTime() - new Date(dates.start).getTime()) / 86400000);
            if (days > 0 && days < 200) historicalDays.push(days);
          }
        }
      }
    } catch {}

    historicalDays.sort((a, b) => a - b);
    const histMedian = historicalDays.length > 0
      ? historicalDays[Math.floor(historicalDays.length / 2)]
      : null;
    const histP75 = historicalDays.length >= 4
      ? historicalDays[Math.floor(historicalDays.length * 0.75)]
      : null;

    // 3. 查当前工厂在手订单数
    let factoryLoad = 0;
    if (order.factory_name) {
      const { count } = await (ctx.supabase.from('orders') as any)
        .select('id', { count: 'exact', head: true })
        .eq('factory_name', order.factory_name)
        .not('lifecycle_status', 'in', '("completed","cancelled","archived","已完成","已取消","已归档")');
      factoryLoad = count || 0;
    }

    // 4. 综合判断
    let severity: 'high' | 'medium' | 'low' = 'low';
    let feasibility: string;

    // 标准 45 天为基线，翻单可以 30 天
    const baselineDays = order.order_type === 'repeat' ? 30 : 45;
    const effectiveBaseline = histMedian || baselineDays;

    if (availableDays < effectiveBaseline * 0.6) {
      severity = 'high';
      feasibility = `🔴 极高风险 — 仅 ${availableDays} 天，历史同类订单需 ${effectiveBaseline} 天`;
    } else if (availableDays < effectiveBaseline * 0.85) {
      severity = 'medium';
      feasibility = `🟡 偏紧 — ${availableDays} 天，历史需 ${effectiveBaseline} 天，需要加快节奏`;
    } else {
      feasibility = `🟢 可行 — ${availableDays} 天，历史需 ${effectiveBaseline} 天，有余量`;
    }

    findings.push({
      category: '交期可行性',
      severity,
      label: feasibility,
      evidence: histMedian
        ? `基于 ${historicalDays.length} 条同工厂历史数据（中位数 ${histMedian} 天，P75 ${histP75} 天）`
        : `基于标准 ${baselineDays} 天基线（无该工厂历史数据）`,
    });

    // 剩余天数提醒
    if (remainingDays < 14) {
      findings.push({
        category: '剩余时间',
        severity: remainingDays < 7 ? 'high' : 'medium',
        label: `距出厂仅剩 ${remainingDays} 天`,
        detail: remainingDays < 7 ? '必须确认所有环节已就绪，否则延期风险极高' : '关注采购和产前样进度',
      });
    }

    // 工厂负荷
    if (factoryLoad > 5) {
      findings.push({
        category: '工厂负荷',
        severity: factoryLoad > 10 ? 'high' : 'medium',
        label: `${order.factory_name} 当前在手 ${factoryLoad} 个订单`,
        detail: factoryLoad > 10 ? '产能可能不足，建议确认工厂排期' : '负荷中等，密切关注',
      });
    }

    // 建议
    const suggestions = [];
    if (severity === 'high') {
      suggestions.push({
        action: '立即和工厂确认能否按期交付，准备 Plan B',
        reason: `交期 ${availableDays} 天低于安全线`,
      });
      if (order.order_type !== 'repeat') {
        suggestions.push({
          action: '考虑跳过产前样（如果老工厂 + 旧款可以跳）',
          reason: '节省 14 天打样周期',
        });
      }
    }
    if (factoryLoad > 8) {
      suggestions.push({
        action: '评估是否需要分厂生产',
        reason: `${order.factory_name} 在手 ${factoryLoad} 单`,
      });
    }

    const confidence = historicalDays.length >= 5 ? 90 : historicalDays.length >= 2 ? 75 : 60;

    return {
      severity,
      summary: feasibility,
      findings,
      suggestions,
      confidence,
      source: historicalDays.length > 0 ? 'rules+ai' : 'rules',
      meta: {
        availableDays,
        remainingDays,
        histMedian,
        histP75,
        historicalCount: historicalDays.length,
        factoryLoad,
        baseline: effectiveBaseline,
      },
    };
  },
};
