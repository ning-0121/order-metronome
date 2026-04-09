/**
 * CMT RAG — 查历史已确认工价样本，用真实数据代替公式猜测
 *
 * 策略：
 *   1. 查 quoter_cmt_training_samples (status=confirmed) 按 garment_type 筛选
 *   2. 有 3+ 条 → 用中位数作为基准，置信度 90+
 *   3. 有 1-2 条 → 用均值但降低置信度
 *   4. 0 条 → 回退到公式计算（原 calculateCmt）
 *
 * 用法：
 *   import { calculateCmtWithRAG } from '@/lib/quoter/cmt/rag';
 *   const result = await calculateCmtWithRAG(supabase, input);
 */

import type { CmtCalculationInput, CmtCalculationResult, CmtOperation, GarmentType } from '../types';
import { calculateCmt } from './calculator';

export interface RagSample {
  id: string;
  style_no: string;
  garment_type: string;
  total_cmt_rmb: number;
  operations: any[];
  ai_raw_text: string | null;
}

/**
 * 工厂利润（加价到加工费）
 *
 * CEO 2026-04-09：Excel 里的是"工价"（工人拿到的），不是"加工费"（付给工厂的）。
 * 加工费 = 工价 + 工厂利润（一般 ¥1~1.5，取中间值 ¥1.25）
 */
const DEFAULT_FACTORY_PROFIT_RMB = 1.25;

export interface CmtRagResult extends CmtCalculationResult {
  /** RAG 匹配到的样本 */
  rag_samples?: Array<{
    style_no: string;
    total_rmb: number;
    ops_count: number;
    description: string;
  }>;
  /** 工价中位数（工人拿到的，不含工厂利润） */
  labor_rate_median?: number;
  /** 工厂利润加价 */
  factory_profit?: number;
  /** 公式计算值（用于对比） */
  formula_total?: number;
  /** 公式 vs RAG 偏差 */
  deviation_pct?: number;
}

/**
 * 带 RAG 的加工费计算
 *
 * @param supabase - Supabase client（可选，传 null 走纯公式）
 * @param input - 计算输入
 */
export async function calculateCmtWithRAG(
  supabase: any | null,
  input: CmtCalculationInput,
): Promise<CmtRagResult> {
  // 先跑公式作为兜底
  const formulaResult = calculateCmt(input);

  if (!supabase) {
    return { ...formulaResult, formula_total: formulaResult.total_rmb };
  }

  try {
    // 查询同品类已确认样本
    const { data: samples, error } = await supabase
      .from('quoter_cmt_training_samples')
      .select('id, style_no, garment_type, total_cmt_rmb, operations, ai_raw_text')
      .eq('status', 'confirmed')
      .eq('garment_type', input.garment_type)
      .not('total_cmt_rmb', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !samples || samples.length === 0) {
      // 0 条 → 纯公式
      return {
        ...formulaResult,
        formula_total: formulaResult.total_rmb,
        reasoning: formulaResult.reasoning + '\n⚠ 无历史样本，纯公式计算',
      };
    }

    const sampleList = samples as RagSample[];
    const prices = sampleList.map(s => s.total_cmt_rmb).sort((a, b) => a - b);

    // 统计
    const median = prices[Math.floor(prices.length / 2)];
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const p25 = prices[Math.floor(prices.length * 0.25)];
    const p75 = prices[Math.floor(prices.length * 0.75)];

    // 复杂度调整：simple -15% / standard 0% / complex +25%
    const complexityAdj =
      input.complexity === 'simple' ? 0.85 :
      input.complexity === 'complex' ? 1.25 : 1.0;
    const adjustedMedian = Number((median * complexityAdj).toFixed(2));

    // 加工厂利润：工价 → 加工费
    const factoryProfit = DEFAULT_FACTORY_PROFIT_RMB;
    const withProfit = Number((adjustedMedian + factoryProfit).toFixed(2));

    // 工厂档次调整（在加工费基础上微调）
    const factoryMult = input.factory_rate_multiplier || 1.0;
    const finalPrice = Number((withProfit * factoryMult).toFixed(2));

    // 偏差：公式 vs RAG
    const deviationPct = formulaResult.total_rmb > 0
      ? Math.round(((finalPrice - formulaResult.total_rmb) / formulaResult.total_rmb) * 100)
      : 0;

    // 构建 RAG 样本列表（显示前 5）
    const ragSamples = sampleList.slice(0, 5).map(s => ({
      style_no: s.style_no || '?',
      total_rmb: s.total_cmt_rmb,
      ops_count: Array.isArray(s.operations) ? s.operations.length : 0,
      description: (s.ai_raw_text || '').slice(0, 60),
    }));

    // 置信度
    let confidence: number;
    if (sampleList.length >= 10) confidence = 95;
    else if (sampleList.length >= 5) confidence = 92;
    else if (sampleList.length >= 3) confidence = 88;
    else confidence = 78;

    // 推荐使用 RAG 价格（中位数已校准的代表性更强）
    // 但如果 RAG 和公式偏差超过 50%，可能样本不适用，降低置信度
    if (Math.abs(deviationPct) > 50) confidence -= 15;

    // 合并工序：取频率最高的 top 样本的工序作为参考
    // 但 RAG 的核心价值是总价，不是工序明细
    // 所以用公式的工序列表（给用户看细节），但总价用 RAG 的
    const adjustedOps = formulaResult.operations.map(op => ({
      ...op,
      // 按比例缩放每道工序，使总和 = finalPrice
      adjusted_rate: Number(
        (op.adjusted_rate * (finalPrice / (formulaResult.total_rmb || 1))).toFixed(2),
      ),
    }));

    // 修正尾差
    const opsTotal = adjustedOps.reduce((s, o) => s + o.adjusted_rate, 0);
    if (adjustedOps.length > 0 && Math.abs(opsTotal - finalPrice) > 0.02) {
      adjustedOps[adjustedOps.length - 1].adjusted_rate += Number(
        (finalPrice - opsTotal).toFixed(2),
      );
    }

    const reasoning = [
      `📊 基于 ${sampleList.length} 条傲狐历史工价样本（RAG 检索）`,
      `工价（工人拿到的）：P25 ¥${p25.toFixed(2)} / 中位数 ¥${median.toFixed(2)} / P75 ¥${p75.toFixed(2)}`,
      input.complexity !== 'standard'
        ? `复杂度调整：${input.complexity}（×${complexityAdj}）→ 工价 ¥${adjustedMedian.toFixed(2)}`
        : '',
      `+ 工厂利润 ¥${factoryProfit.toFixed(2)}（工价 → 加工费）`,
      factoryMult !== 1.0
        ? `工厂档次系数：×${factoryMult}`
        : '',
      `🎯 加工费（付给工厂的）：¥${finalPrice.toFixed(2)} / 件`,
      sampleList.length < 5
        ? `⚠ 样本偏少（${sampleList.length} 条），建议继续导入更多工价单`
        : '',
    ].filter(Boolean).join('\n');

    return {
      total_rmb: finalPrice,
      operations: adjustedOps,
      reasoning,
      confidence,
      source: 'rules+ai' as const,
      rag_samples: ragSamples,
      labor_rate_median: median,
      factory_profit: factoryProfit,
      formula_total: formulaResult.total_rmb,
      deviation_pct: deviationPct,
    };
  } catch (e: any) {
    console.error('[CMT RAG] query error:', e?.message);
    // RAG 失败 → 回退公式
    return {
      ...formulaResult,
      formula_total: formulaResult.total_rmb,
      reasoning: formulaResult.reasoning + `\n⚠ RAG 查询失败（${e?.message}），使用公式兜底`,
    };
  }
}
