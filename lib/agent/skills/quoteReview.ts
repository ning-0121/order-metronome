/**
 * Skill 3 — 报价审核
 *
 * 对比订单的内部成本 vs 客户报价，守护利润率。
 *
 * 数据来源：
 *   1. order_cost_baseline（内部成本核算单解析后的成本基线）
 *   2. orders 表的 FOB/DDP 报价
 *   3. 报价员 Quoter 的 RAG 数据（同品类历史利润率）
 *
 * 输出：
 *   - 利润率是否健康
 *   - 各成本项占比
 *   - 同客户/同品类历史利润率对比
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';

export const quoteReviewSkill: SkillModule = {
  name: 'quote_review',
  displayName: '报价审核',
  cacheTtlMs: 60 * 60 * 1000, // 1h

  hashInput: (input: SkillInput) =>
    JSON.stringify({ orderId: input.orderId, version: 'v2-calibrated' }),

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    if (!input.orderId) throw new Error('需要 orderId');

    // 读取订单
    const { data: order } = await (ctx.supabase.from('orders') as any)
      .select('id, order_no, customer_name, quantity, incoterm')
      .eq('id', input.orderId)
      .single();
    if (!order) throw new Error('订单不存在');

    // 读取成本基线
    const { data: baseline } = await (ctx.supabase.from('order_cost_baseline') as any)
      .select('*')
      .eq('order_id', input.orderId)
      .single();

    const findings: SkillFinding[] = [];

    if (!baseline) {
      return {
        severity: 'low',
        summary: '⚠ 未上传内部成本核算单，无法审核利润率',
        findings: [{
          category: '数据缺失',
          severity: 'medium',
          label: '请先在"成本控制"Tab 上传内部成本核算单',
          detail: '上传后系统会自动解析面料单耗、加工费、总成本，并对比客户报价',
        }],
        suggestions: [{ action: '去"成本控制"Tab 上传内部成本核算单', reason: '利润率审核需要成本基线' }],
        confidence: 0,
        source: 'rules',
      };
    }

    // 计算利润率
    const costPerPiece = baseline.total_cost_per_piece || 0;
    const sellingPrice = order.incoterm === 'DDP'
      ? (baseline.ddp_price || 0)
      : (baseline.fob_price || 0);
    // 汇率：优先从成本基线读取，fallback 7.2
    const exchangeRate = baseline.exchange_rate || 7.2;
    const sellingPriceRmb = sellingPrice * exchangeRate;

    // 售价为 0 但有成本 → 可能没填报价
    if (sellingPrice === 0 && costPerPiece > 0) {
      return {
        severity: 'medium',
        summary: '⚠ 客户报价未录入，无法计算利润率',
        findings: [{
          category: '数据缺失',
          severity: 'medium',
          label: `成本 ¥${costPerPiece.toFixed(2)}/件，但 ${order.incoterm} 报价为 0`,
          detail: '请在成本基线中录入客户报价（FOB/DDP Price）',
        }],
        suggestions: [{ action: '在"成本控制"Tab 补充客户报价', reason: '报价为空导致利润率无法计算' }],
        confidence: 30,
        source: 'rules',
      };
    }
    const profitPerPiece = sellingPriceRmb - costPerPiece;
    const profitRate = sellingPriceRmb > 0
      ? Number(((profitPerPiece / sellingPriceRmb) * 100).toFixed(1))
      : 0;
    const totalProfit = profitPerPiece * (order.quantity || 0);

    // 利润率健康度
    let severity: 'high' | 'medium' | 'low' = 'low';

    if (profitRate < 8) {
      severity = 'high';
      findings.push({
        category: '利润率',
        severity: 'high',
        label: `🔴 利润率仅 ${profitRate}% — 严重偏低`,
        detail: `成本 ¥${costPerPiece.toFixed(2)}/件，售价 $${sellingPrice}/件（≈¥${sellingPriceRmb.toFixed(2)}，汇率 ${exchangeRate}），利润 ¥${profitPerPiece.toFixed(2)}/件`,
        evidence: `order_cost_baseline: total_cost=${costPerPiece}, ${order.incoterm}_price=${sellingPrice}`,
      });
    } else if (profitRate < 15) {
      severity = 'medium';
      findings.push({
        category: '利润率',
        severity: 'medium',
        label: `🟡 利润率 ${profitRate}% — 偏低但可接受`,
        detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}（汇率 ${exchangeRate}）`,
      });
    } else {
      findings.push({
        category: '利润率',
        severity: 'low',
        label: `🟢 利润率 ${profitRate}% — 健康`,
        detail: `利润 ¥${profitPerPiece.toFixed(2)}/件，总利润 ¥${totalProfit.toFixed(0)}（汇率 ${exchangeRate}）`,
      });
    }

    // 成本构成分析
    const fabricCost = (baseline.fabric_consumption_kg || 0) * (baseline.fabric_price_per_kg || 0);
    const cmtCost = baseline.cmt_factory_quote || baseline.cmt_internal_estimate || 0;
    if (costPerPiece > 0) {
      const fabricPct = (fabricCost / costPerPiece * 100).toFixed(0);
      const cmtPct = (cmtCost / costPerPiece * 100).toFixed(0);
      const otherPct = (100 - Number(fabricPct) - Number(cmtPct)).toFixed(0);
      findings.push({
        category: '成本构成',
        severity: 'low',
        label: `面料 ${fabricPct}% + 加工 ${cmtPct}% + 其他 ${otherPct}%`,
        detail: `面料 ¥${fabricCost.toFixed(2)} + 加工 ¥${cmtCost.toFixed(2)} + 其他 ¥${(costPerPiece - fabricCost - cmtCost).toFixed(2)}`,
      });
    }

    // 加工费合理性（小单允许更大偏差）
    if (baseline.cmt_internal_estimate && baseline.cmt_factory_quote) {
      const cmtDiff = ((baseline.cmt_factory_quote - baseline.cmt_internal_estimate) / baseline.cmt_internal_estimate * 100).toFixed(1);
      const cmtThreshold = (order.quantity || 0) < 1000 ? 20 : 15; // 小单放宽到 20%
      if (Number(cmtDiff) > cmtThreshold) {
        findings.push({
          category: '加工费',
          severity: 'medium',
          label: `⚠ 工厂报价高于内部估价 ${cmtDiff}%`,
          detail: `内部估 ¥${baseline.cmt_internal_estimate} vs 工厂报 ¥${baseline.cmt_factory_quote}`,
        });
      }
    }

    // 同客户历史利润率对比（查该客户其他订单的 baseline）
    try {
      const { data: histBaselines } = await (ctx.supabase.from('order_cost_baseline') as any)
        .select('total_cost_per_piece, fob_price, ddp_price, order_id')
        .neq('order_id', input.orderId)
        .limit(10);
      // 通过 order_id 反查同客户的
      if (histBaselines && histBaselines.length > 0) {
        const histOrderIds = (histBaselines as any[]).map(b => b.order_id);
        const { data: histOrders } = await (ctx.supabase.from('orders') as any)
          .select('id, customer_name, incoterm')
          .in('id', histOrderIds)
          .eq('customer_name', order.customer_name);
        if (histOrders && histOrders.length > 0) {
          const sameCustomerIds = new Set((histOrders as any[]).map(o => o.id));
          const sameCustomerBaselines = (histBaselines as any[]).filter(b => sameCustomerIds.has(b.order_id));
          if (sameCustomerBaselines.length > 0) {
            const histRates = sameCustomerBaselines.map(b => {
              const sp = (b.fob_price || b.ddp_price || 0) * exchangeRate;
              return sp > 0 ? ((sp - (b.total_cost_per_piece || 0)) / sp * 100) : 0;
            }).filter(r => r > 0);
            if (histRates.length > 0) {
              const histAvg = (histRates.reduce((a, b) => a + b, 0) / histRates.length).toFixed(1);
              findings.push({
                category: '历史对比',
                severity: profitRate < Number(histAvg) - 5 ? 'medium' : 'low',
                label: `该客户历史平均利润率 ${histAvg}%，本单 ${profitRate}%`,
                evidence: `基于 ${histRates.length} 个历史订单`,
              });
            }
          }
        }
      }
    } catch {}

    const summary = profitRate < 8
      ? `🔴 利润率 ${profitRate}% 严重偏低 — 建议重新谈价`
      : profitRate < 15
      ? `🟡 利润率 ${profitRate}% — 可接受但偏低`
      : `🟢 利润率 ${profitRate}% — 健康`;

    return {
      severity,
      summary,
      findings,
      suggestions: profitRate < 15
        ? [{ action: `利润率 ${profitRate}%，建议和客户沟通提价或优化成本`, reason: '利润空间不足' }]
        : [],
      confidence: 90,
      source: 'rules',
      meta: { costPerPiece, sellingPrice, sellingPriceRmb, profitPerPiece, profitRate, totalProfit },
    };
  },
};
