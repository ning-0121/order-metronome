/**
 * Root Cause Engine — 主入口（Step 2 实现版）
 *
 * 调用方约定：
 *   - 仅 Server Actions / Cron / API Route 调用
 *   - 永不在 markMilestoneDone 等主流程内同步触发
 *   - 失败必须 try/catch，不向上抛出
 *
 * 幂等 + 自愈：
 *   - 同一 (order_id, cause_code, stage) 的 active 记录通过 unique 约束唯一
 *   - 已有但本次未触发 → 自动 resolved（resolution_note='规则自动消除'）
 */

import { createClient } from '@/lib/supabase/server';
import { rootCauseEngineEnabled } from './featureFlags';
import { ALL_CAUSE_RULES } from './rules/causeRules';
import type {
  CauseEvaluation,
  OrderContext,
  OrderContextSignals,
  RootCause,
  RootCauseScanResult,
} from './types';

interface ScanOptions {
  source?: 'rule' | 'ai' | 'manual';
  triggerUser?: string;
  /** 跑规则但不写库（用于调试） */
  dryRun?: boolean;
}

// ═══════════════════════════════════════════════════════════════
//  buildOrderContext — 加载订单全部上下文
// ═══════════════════════════════════════════════════════════════

export async function buildOrderContext(orderId: string): Promise<OrderContext | null> {
  try {
    const supabase = await createClient();

    const [
      orderRes,
      milestonesRes,
      financialsRes,
      baselineRes,
      confirmationsRes,
      reportsRes,
      causesRes,
    ] = await Promise.all([
      (supabase.from('orders') as any).select('*').eq('id', orderId).single(),
      (supabase.from('milestones') as any).select('*').eq('order_id', orderId).order('due_at', { ascending: true }),
      (supabase.from('order_financials') as any).select('*').eq('order_id', orderId).maybeSingle(),
      (supabase.from('order_cost_baseline') as any).select('*').eq('order_id', orderId).maybeSingle(),
      (supabase.from('order_confirmations') as any).select('*').eq('order_id', orderId),
      (supabase.from('production_reports') as any).select('*').eq('order_id', orderId).order('report_date', { ascending: false }).limit(50),
      (supabase.from('order_root_causes') as any).select('*').eq('order_id', orderId).eq('status', 'active'),
    ]);

    if (orderRes.error || !orderRes.data) return null;

    const order = orderRes.data;
    const milestones = milestonesRes.data || [];
    const financials = financialsRes.data ?? null;
    const baseline = baselineRes.data ?? null;
    const confirmations = confirmationsRes.data || [];
    const productionReports = reportsRes.data || [];
    const activeCauses = causesRes.data || [];

    // 计算 signals
    const now = new Date();
    const overdueCount = milestones.filter((m: any) => {
      const status = String(m.status || '').toLowerCase();
      return status !== 'done' && status !== '已完成' && m.due_at && new Date(m.due_at) < now;
    }).length;
    const blockedCount = milestones.filter((m: any) => {
      const status = String(m.status || '').toLowerCase();
      return status === 'blocked' || status === '卡住';
    }).length;

    let daysToETD: number | null = null;
    if (order.etd) {
      daysToETD = Math.ceil((new Date(order.etd).getTime() - now.getTime()) / 86400000);
    } else if (order.factory_date) {
      daysToETD = Math.ceil((new Date(order.factory_date).getTime() - now.getTime()) / 86400000);
    }

    let marginPct: number | null = null;
    if (financials?.margin_pct != null) {
      marginPct = Number(financials.margin_pct);
    } else if (baseline?.total_cost_per_piece && baseline?.fob_price) {
      const cost = Number(baseline.total_cost_per_piece);
      const price = Number(baseline.fob_price);
      if (price > 0) marginPct = ((price - cost) / price) * 100;
    }

    const depositReceived = financials?.deposit_status === 'received';
    const balanceReceived = financials?.balance_status === 'received';
    const paymentHold = financials?.payment_hold === true;

    const signals: OrderContextSignals = {
      overdueCount,
      blockedCount,
      daysToETD,
      marginPct,
      depositReceived,
      balanceReceived,
      paymentHold,
    };

    return {
      order,
      milestones,
      financials,
      baseline,
      confirmations,
      productionReports,
      activeCauses,
      signals,
    };
  } catch (err: any) {
    console.error('[buildOrderContext] failed:', err?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  scanOrder — 主扫描入口
// ═══════════════════════════════════════════════════════════════

export async function scanOrder(
  orderId: string,
  opts: ScanOptions = {},
): Promise<RootCauseScanResult> {
  const empty: RootCauseScanResult = {
    newCauses: 0,
    updatedCauses: 0,
    resolvedCauses: 0,
    errors: [],
    rulesEvaluated: 0,
  };

  if (!rootCauseEngineEnabled()) return empty;
  if (ALL_CAUSE_RULES.length === 0) return empty;

  const ctx = await buildOrderContext(orderId);
  if (!ctx) {
    empty.errors.push('build_context_failed');
    return empty;
  }

  const errors: string[] = [];
  const matched: Array<{ rule: typeof ALL_CAUSE_RULES[number]; result: CauseEvaluation }> = [];

  // 1) 跑所有规则
  for (const rule of ALL_CAUSE_RULES) {
    try {
      const result = rule.evaluate(ctx);
      if (result && result.matched) {
        matched.push({ rule, result });
      }
    } catch (err: any) {
      errors.push(`${rule.code}: ${err?.message ?? 'unknown'}`);
    }
  }

  if (opts.dryRun) {
    return {
      newCauses: matched.length,
      updatedCauses: 0,
      resolvedCauses: 0,
      errors,
      rulesEvaluated: ALL_CAUSE_RULES.length,
    };
  }

  // 2) 写库
  const supabase = await createClient();
  let newCauses = 0;
  let updatedCauses = 0;
  let resolvedCauses = 0;

  const matchedCodes = new Set(matched.map(m => m.rule.code));
  const existingByCode = new Map<string, RootCause>();
  for (const c of ctx.activeCauses) {
    existingByCode.set(`${c.cause_code}::${c.stage ?? ''}`, c);
  }

  // 2a) upsert 触发的规则
  for (const { rule, result } of matched) {
    const key = `${rule.code}::${result.stage ?? ''}`;
    const existing = existingByCode.get(key);
    const payload: Record<string, unknown> = {
      order_id: orderId,
      cause_domain: rule.domain,
      cause_type: rule.type,
      cause_code: rule.code,
      cause_title: rule.title,
      cause_description: result.description ?? null,
      stage: result.stage,
      responsible_role: result.responsible_role,
      impact_days: result.impact_days,
      impact_cost: result.impact_cost,
      severity: result.severity,
      confidence_score: result.confidence,
      source: opts.source ?? 'rule',
      evidence_json: result.evidence,
      status: 'active',
      created_by: opts.triggerUser ?? null,
    };

    try {
      if (existing) {
        // 更新 evidence + severity + impact（cause_title/code 不变）
        const { error } = await (supabase.from('order_root_causes') as any)
          .update({
            cause_description: payload.cause_description,
            responsible_role: payload.responsible_role,
            impact_days: payload.impact_days,
            impact_cost: payload.impact_cost,
            severity: payload.severity,
            confidence_score: payload.confidence_score,
            evidence_json: payload.evidence_json,
          })
          .eq('id', existing.id);
        if (error) errors.push(`update ${rule.code}: ${error.message}`);
        else updatedCauses++;
      } else {
        const { error } = await (supabase.from('order_root_causes') as any).insert(payload);
        if (error) errors.push(`insert ${rule.code}: ${error.message}`);
        else newCauses++;
      }
    } catch (err: any) {
      errors.push(`write ${rule.code}: ${err?.message ?? 'unknown'}`);
    }
  }

  // 2b) 自动 resolve 不再触发的 active causes（仅 source='rule'，避免误关人工标记）
  for (const c of ctx.activeCauses) {
    const key = `${c.cause_code}::${c.stage ?? ''}`;
    if (matchedCodes.has(c.cause_code) && existingByCode.has(key)) continue;
    if (c.source !== 'rule') continue; // 人工/AI 创建的不自动消除
    if (matched.some(m => m.rule.code === c.cause_code && (m.result.stage ?? '') === (c.stage ?? ''))) continue;

    try {
      const { error } = await (supabase.from('order_root_causes') as any)
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolution_note: '规则自动消除（条件不再满足）',
        })
        .eq('id', c.id);
      if (error) errors.push(`resolve ${c.cause_code}: ${error.message}`);
      else resolvedCauses++;
    } catch (err: any) {
      errors.push(`resolve ${c.cause_code}: ${err?.message ?? 'unknown'}`);
    }
  }

  return {
    newCauses,
    updatedCauses,
    resolvedCauses,
    errors,
    rulesEvaluated: ALL_CAUSE_RULES.length,
  };
}

// ═══════════════════════════════════════════════════════════════
//  scanAllActiveOrders — 批量扫描入口（Cron 用，本期不启用）
// ═══════════════════════════════════════════════════════════════

export async function scanAllActiveOrders(): Promise<{
  totalOrders: number;
  totalCauses: number;
  errors: string[];
}> {
  if (!rootCauseEngineEnabled()) {
    return { totalOrders: 0, totalCauses: 0, errors: [] };
  }

  // Step 2 暂不启用 — Cron 接入留 Step 4/5
  return { totalOrders: 0, totalCauses: 0, errors: [] };
}
