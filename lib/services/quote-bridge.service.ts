/**
 * Quote Bridge Service — 报价 → 订单 → 利润数据流桥接
 *
 * ══ System Consolidation Sprint 2026-04-27 ══
 *
 * 设计原则：
 *   - 不修改 quoter_quotes 原结构
 *   - 不修改 orders 主结构
 *   - 不影响现有创建订单流程
 *   - 数据不完整时明确返回 missing fields，不静默失败
 *   - Admin-only，手动触发（不自动批量同步）
 *
 * 数据流：
 *   quoter_quotes → order_financials (upsert) → profit_snapshots (insert) → order_logs
 *
 * 用法：
 *   const result = await convertQuoteToOrderFinancials(supabase, quoteId, orderId);
 *   if (!result.ok) console.error(result.error, result.missingFields);
 */

import type { ServiceResult } from './types';

// ── 类型定义 ──────────────────────────────────────────────────

export interface QuoteBridgeResult {
  /** order_financials 行 ID */
  financialsId: string;
  /** profit_snapshots 行 ID */
  snapshotId: string;
  /** 警告：哪些字段是从 quote 估算的，实际应填写真实值 */
  warningFields: string[];
  /** 来源报价号 */
  quoteNo: string;
}

export interface QuoteBridgeError {
  /** 缺少的必须字段 */
  missingFields: string[];
  /** 可读错误描述 */
  message: string;
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * 将报价单数据桥接到订单财务 + 利润快照
 *
 * @param supabase  Supabase 客户端（调用者传入，带 auth 上下文或 service role）
 * @param quoteId   quoter_quotes.id
 * @param orderId   orders.id
 * @returns ServiceResult<QuoteBridgeResult>
 */
export async function convertQuoteToOrderFinancials(
  supabase: any,
  quoteId: string,
  orderId: string,
): Promise<ServiceResult<QuoteBridgeResult>> {
  // ── 1. 读取报价单 ─────────────────────────────────────────

  const { data: quote, error: quoteErr } = await (supabase.from('quoter_quotes') as any)
    .select(`
      id, quote_no, customer_name, style_no, quantity,
      currency, exchange_rate,
      fabric_cost_per_piece, cmt_cost_per_piece,
      trim_cost_per_piece, packing_cost_per_piece, logistics_cost_per_piece,
      total_cost_per_piece, quote_price_per_piece,
      margin_rate, status
    `)
    .eq('id', quoteId)
    .single();

  if (quoteErr || !quote) {
    return { ok: false, error: `报价单不存在或无权限（id: ${quoteId}）` };
  }

  // ── 2. 验证订单存在 ───────────────────────────────────────

  const { data: order, error: orderErr } = await (supabase.from('orders') as any)
    .select('id, order_no, quantity, lifecycle_status')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) {
    return { ok: false, error: `订单不存在或无权限（id: ${orderId}）` };
  }

  // ── 3. 字段完整性检查 ─────────────────────────────────────

  const missingFields: string[] = [];
  const warningFields: string[] = [];

  // 必须字段
  if (!quote.quote_price_per_piece) missingFields.push('quote_price_per_piece（报价单价）');
  if (!quote.currency)              missingFields.push('currency（报价币种）');
  if (!quote.quantity)              missingFields.push('quantity（报价数量）');

  if (missingFields.length > 0) {
    return {
      ok: false,
      error: `报价单关键字段缺失，无法桥接：${missingFields.join('、')}`,
      code: 'MISSING_FIELDS',
    };
  }

  // 警告字段（有估算值，但不阻断）
  if (!quote.fabric_cost_per_piece) warningFields.push('fabric_cost_per_piece（面料成本）');
  if (!quote.cmt_cost_per_piece)    warningFields.push('cmt_cost_per_piece（加工费）');
  if (!quote.exchange_rate)         warningFields.push('exchange_rate（汇率）');

  // 汇率兜底
  const exchangeRate: number = quote.exchange_rate || 7.2;
  const qty: number = order.quantity || quote.quantity;

  // ── 4. 计算各成本字段（统一换算为 RMB/件） ───────────────

  // quoter 的成本字段都是 RMB/件
  const costMaterialRmb  = Number(quote.fabric_cost_per_piece || 0);
  const costCmtRmb       = Number(quote.cmt_cost_per_piece || 0);
  const costShippingRmb  = Number(quote.logistics_cost_per_piece || 0);
  const costOtherRmb     = Number(quote.trim_cost_per_piece || 0)
                         + Number(quote.packing_cost_per_piece || 0);

  // total_cost_per_piece 如果 quote 里有就用，没有就加总
  const costTotalRmb = quote.total_cost_per_piece
    ? Number(quote.total_cost_per_piece)
    : costMaterialRmb + costCmtRmb + costShippingRmb + costOtherRmb;

  // 销售单价：换算成 RMB
  const quotePricePerPiece = Number(quote.quote_price_per_piece);
  const salePriceRmb = quote.currency === 'RMB'
    ? quotePricePerPiece
    : quotePricePerPiece * exchangeRate;

  const saleTotalRmb = salePriceRmb * qty;

  // 毛利率
  const grossProfitRmb = saleTotalRmb - costTotalRmb * qty;
  const marginPct = saleTotalRmb > 0 ? grossProfitRmb / saleTotalRmb : null;

  // ── 5. Upsert order_financials ────────────────────────────

  const financialsPayload = {
    order_id: orderId,
    // 报价来源
    source_quote_id:     quoteId,
    // 销售价格
    sale_price_per_piece: quotePricePerPiece,
    sale_currency:        quote.currency || 'USD',
    sale_total:           Number((quotePricePerPiece * qty).toFixed(2)),
    exchange_rate:        exchangeRate,
    // 成本分拆（RMB/件）
    cost_material:        Number(costMaterialRmb.toFixed(2)),
    cost_cmt:             Number(costCmtRmb.toFixed(2)),
    cost_shipping:        Number(costShippingRmb.toFixed(2)),
    cost_other:           Number(costOtherRmb.toFixed(2)),
    cost_total:           Number(costTotalRmb.toFixed(2)),
    // 利润
    gross_profit_rmb:     Number(grossProfitRmb.toFixed(2)),
    margin_pct:           marginPct !== null ? Number(marginPct.toFixed(4)) : null,
    updated_at:           new Date().toISOString(),
  };

  const { data: financials, error: finErr } = await (supabase.from('order_financials') as any)
    .upsert(financialsPayload, { onConflict: 'order_id' })
    .select('id')
    .single();

  if (finErr || !financials) {
    return { ok: false, error: `写入 order_financials 失败：${finErr?.message || '未知错误'}` };
  }

  // ── 6. Insert profit_snapshots（第一版快照，type = quote_estimate） ─

  const snapshotType = 'quote_estimate';

  // 判断利润状态
  const marginStatus = !marginPct
    ? 'unknown'
    : marginPct < 0   ? 'negative'
    : marginPct < 0.05 ? 'critical'
    : marginPct < 0.10 ? 'warning'
    : 'normal';

  const snapshotPayload = {
    order_id:         orderId,
    snapshot_type:    snapshotType,
    revenue_usd:      quote.currency === 'USD' ? Number((quotePricePerPiece * qty).toFixed(2)) : null,
    revenue_cny:      Number(saleTotalRmb.toFixed(2)),
    exchange_rate:    exchangeRate,
    material_cost:    Number((costMaterialRmb * qty).toFixed(2)),
    processing_cost:  Number((costCmtRmb * qty).toFixed(2)),
    logistics_cost:   Number((costShippingRmb * qty).toFixed(2)),
    other_cost:       Number((costOtherRmb * qty).toFixed(2)),
    total_cost:       Number((costTotalRmb * qty).toFixed(2)),
    gross_profit:     Number(grossProfitRmb.toFixed(2)),
    gross_margin:     marginPct,
    margin_status:    marginStatus,
    data_completeness: warningFields.length === 0 ? 100 : Math.max(60, 100 - warningFields.length * 15),
    missing_fields:   warningFields,
    updated_at:       new Date().toISOString(),
  };

  const { data: snapshot, error: snapErr } = await (supabase.from('profit_snapshots') as any)
    .upsert(snapshotPayload, { onConflict: 'order_id,snapshot_type' })
    .select('id')
    .single();

  if (snapErr || !snapshot) {
    // 非致命错误：财务已写成功，快照失败只记录警告
    console.warn(`[quote-bridge] profit_snapshots 写入失败：${snapErr?.message}（不影响财务数据）`);
  }

  // ── 7. 写 order_logs 记录来源 ─────────────────────────────

  await (supabase.from('order_logs') as any).insert({
    order_id:  orderId,
    action:    'quote_bridge',
    note:      `从报价单 ${quote.quote_no} 导入财务数据：单价 ${quotePricePerPiece} ${quote.currency}，利润率 ${marginPct !== null ? (marginPct * 100).toFixed(1) + '%' : '未知'}`,
    metadata:  { quoteId, quoteNo: quote.quote_no, warningFields },
    created_at: new Date().toISOString(),
  }).select().maybeSingle(); // 忽略错误（order_logs 非必须）

  return {
    ok: true,
    data: {
      financialsId: (financials as any).id,
      snapshotId:   snapshot ? (snapshot as any).id : '',
      warningFields,
      quoteNo:      quote.quote_no || quoteId,
    },
  };
}

// ── 管理员 API 快速查询：报价是否可桥接 ───────────────────────

/**
 * 检查报价单是否满足桥接条件（字段完整性 + 状态检查）
 * 仅查询，不写入
 */
export async function checkQuoteBridgeEligibility(
  supabase: any,
  quoteId: string,
): Promise<{ eligible: boolean; reason?: string; missingFields?: string[] }> {
  const { data: quote } = await (supabase.from('quoter_quotes') as any)
    .select('id, quote_no, status, quote_price_per_piece, currency, quantity')
    .eq('id', quoteId)
    .single();

  if (!quote) return { eligible: false, reason: '报价单不存在' };

  const missing: string[] = [];
  if (!quote.quote_price_per_piece) missing.push('quote_price_per_piece');
  if (!quote.currency)              missing.push('currency');
  if (!quote.quantity)              missing.push('quantity');

  if (missing.length > 0) {
    return { eligible: false, reason: '缺少必要字段', missingFields: missing };
  }

  if (!['sent', 'won'].includes(quote.status)) {
    return {
      eligible: false,
      reason: `报价状态为 "${quote.status}"，建议在 sent/won 状态下桥接`,
    };
  }

  return { eligible: true };
}
