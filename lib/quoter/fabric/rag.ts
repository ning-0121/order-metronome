/**
 * 面料单耗 RAG — 用实测数据校准公式
 *
 * 策略：
 *   1. 查 quoter_fabric_records 按 garment_type 匹配
 *   2. 有 3+ 条 → 用中位数作为基准（置信度 90+）
 *   3. 有 1-2 条 → 均值但降低置信度
 *   4. 0 条 → 回退公式
 *
 * CEO 规则：损耗率固定 3%
 */

import type { FabricConsumptionInput, FabricConsumptionResult } from '../types';
import { calculateFabricConsumption } from './calculator';

interface FabricRecord {
  id: string;
  style_no: string;
  garment_type: string;
  garment_subtype: string | null;
  consumption_kg: number;
  customer_name: string | null;
  notes: string | null;
}

export async function calculateFabricWithRAG(
  supabase: any | null,
  input: FabricConsumptionInput,
): Promise<FabricConsumptionResult> {
  // 公式兜底
  const formulaResult = calculateFabricConsumption(input);

  if (!supabase) return formulaResult;

  try {
    // 查同品类实测记录
    let query = supabase
      .from('quoter_fabric_records')
      .select('id, style_no, garment_type, garment_subtype, consumption_kg, customer_name, notes')
      .eq('garment_type', input.garment_type)
      .not('consumption_kg', 'is', null)
      .order('created_at', { ascending: false })
      .limit(30);

    // 如果有子类型，优先匹配
    if (input.subtype) {
      const { data: subtypeRecords } = await query.eq('garment_subtype', input.subtype);
      const { data: allRecords } = await supabase
        .from('quoter_fabric_records')
        .select('id, style_no, garment_type, garment_subtype, consumption_kg, customer_name, notes')
        .eq('garment_type', input.garment_type)
        .not('consumption_kg', 'is', null)
        .order('created_at', { ascending: false })
        .limit(30);

      // 优先用子类型匹配，不够 3 条就扩大到整个品类
      const records: FabricRecord[] =
        (subtypeRecords || []).length >= 3 ? subtypeRecords : (allRecords || []);

      return buildRAGResult(records as FabricRecord[], formulaResult, input);
    }

    const { data: records } = await query;
    return buildRAGResult((records || []) as FabricRecord[], formulaResult, input);
  } catch (e: any) {
    console.error('[Fabric RAG] error:', e?.message);
    return {
      ...formulaResult,
      reasoning: formulaResult.reasoning + '\n⚠ RAG 查询失败，使用公式兜底',
    };
  }
}

function buildRAGResult(
  records: FabricRecord[],
  formulaResult: FabricConsumptionResult,
  input: FabricConsumptionInput,
): FabricConsumptionResult {
  if (records.length === 0) {
    return {
      ...formulaResult,
      reasoning: formulaResult.reasoning + '\n⚠ 无历史实测数据，纯公式计算',
    };
  }

  const values = records.map(r => r.consumption_kg).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const p25 = values[Math.floor(values.length * 0.25)];
  const p75 = values[Math.floor(values.length * 0.75)];

  // 置信度
  let confidence: number;
  if (records.length >= 10) confidence = 95;
  else if (records.length >= 5) confidence = 92;
  else if (records.length >= 3) confidence = 88;
  else confidence = 75;

  // RAG 推荐值 = 中位数（已含损耗 — 实测数据本身就是真实用量）
  const ragKg = median;

  // 公式 vs RAG 偏差
  const formulaKg = formulaResult.avg_kg;
  const deviationPct = formulaKg > 0
    ? Math.round(((ragKg - formulaKg) / formulaKg) * 100)
    : 0;

  const similarRecords = records.slice(0, 5).map(r => ({
    id: r.id,
    garment_type: r.garment_type,
    fabric_type: r.garment_subtype || '',
    consumption_kg: r.consumption_kg,
    similarity_score: 1, // 简化：同品类视为相似
  }));

  const reasoning = [
    `📊 基于 ${records.length} 条实测单耗数据（RAG 检索）`,
    `实测范围：P25 ${p25.toFixed(3)} / 中位数 ${median.toFixed(3)} / P75 ${p75.toFixed(3)} KG/件`,
    `🎯 RAG 推荐单耗：${ragKg.toFixed(3)} KG/件`,
    `📐 公式计算：${formulaKg.toFixed(3)} KG/件（偏差 ${deviationPct > 0 ? '+' : ''}${deviationPct}%）`,
    records.length < 5 ? `⚠ 样本偏少（${records.length} 条），建议继续积累实测数据` : '',
  ].filter(Boolean).join('\n');

  return {
    primary_size_kg: ragKg,
    avg_kg: ragKg,
    area_m2: formulaResult.area_m2, // 面积仍用公式（RAG 不需要面积）
    reasoning,
    factors: formulaResult.factors,
    similar_records: similarRecords,
    confidence,
    source: 'formula+rag',
  };
}
