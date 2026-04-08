/**
 * 加工费计算器 — Phase 1: 工序拆解 + 工价累加
 *
 * 算法：
 *   1. 从默认工序库按 garment_type 取必选工序
 *   2. 根据 complexity（简单/标准/复杂）调整工时系数
 *   3. 求和 → 基础加工费
 *   4. 按工厂档次乘系数
 *
 * Phase 2 会加：
 *   - Claude Vision 识图 → 自动判断复杂度 + 选装工序
 *   - RAG 历史加工费报价单 → 校准工价
 */

import type {
  CmtCalculationInput,
  CmtCalculationResult,
  CmtOperation,
} from '../types';
import { getDefaultOperationsForType } from './defaultOperations';

const COMPLEXITY_MULTIPLIER: Record<'simple' | 'standard' | 'complex', number> = {
  simple: 0.85,
  standard: 1.0,
  complex: 1.25,
};

export function calculateCmt(input: CmtCalculationInput): CmtCalculationResult {
  const {
    garment_type,
    complexity = 'standard',
    operations,
    factory_rate_multiplier = 1.0,
  } = input;

  // 1. 取工序清单 — 用户传入 or 默认库
  const ops: CmtOperation[] =
    operations && operations.length > 0
      ? operations
      : getDefaultOperationsForType(garment_type, false).map(t => ({
          code: t.code,
          name: t.name,
          category: t.category,
          base_rate_rmb: t.base_rate_rmb,
          complexity_factor: t.complexity_factor,
        }));

  if (ops.length === 0) {
    throw new Error(`找不到 ${garment_type} 的默认工序库，请先在训练数据中添加`);
  }

  const complexityMult = COMPLEXITY_MULTIPLIER[complexity];

  // 2. 逐项应用复杂度 + 工厂系数
  const adjustedOps = ops.map(op => {
    const opComplexity = op.complexity_factor || 1.0;
    const adjustedRate =
      op.base_rate_rmb * opComplexity * complexityMult * factory_rate_multiplier;
    return {
      ...op,
      adjusted_rate: Number(adjustedRate.toFixed(2)),
    };
  });

  const totalRmb = adjustedOps.reduce((sum, op) => sum + op.adjusted_rate, 0);

  // 3. 生成说明
  const categorySums: Record<string, number> = {};
  for (const op of adjustedOps) {
    const cat = op.category || 'other';
    categorySums[cat] = (categorySums[cat] || 0) + op.adjusted_rate;
  }

  const categoryBreakdown = Object.entries(categorySums)
    .map(([cat, sum]) => {
      const label =
        cat === 'cutting' ? '裁剪' :
        cat === 'sewing' ? '缝制' :
        cat === 'finishing' ? '整烫/检验' :
        cat === 'packing' ? '包装' : cat;
      return `${label} ${sum.toFixed(2)}`;
    })
    .join(' + ');

  const reasoning = [
    `品类：${garment_type}（复杂度：${complexity}，系数 ×${complexityMult}）`,
    `工序数：${adjustedOps.length} 道`,
    `分类汇总：${categoryBreakdown}`,
    factory_rate_multiplier !== 1.0
      ? `工厂档次系数：×${factory_rate_multiplier}`
      : '',
    `合计：${totalRmb.toFixed(2)} RMB/件`,
  ]
    .filter(Boolean)
    .join('\n');

  // 4. 置信度：使用默认工序置信度较低，用户自定义工序置信度较高
  const confidence = operations && operations.length > 0 ? 85 : 72;

  return {
    total_rmb: Number(totalRmb.toFixed(2)),
    operations: adjustedOps,
    reasoning,
    confidence,
    source: 'rules',
  };
}
