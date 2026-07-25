'use server';

/**
 * Knowledge Layer K1 — Material Decision Capture · Server Actions
 *
 * 入口：
 *  - captureMaterialDecision(input)        BomTab 关键编辑后 fire-and-forget 落决策 + order_logs 轨迹
 *  - listMaterialDecisions(orderId)        订单维度决策历史（价格字段按角色屏蔽）
 *  - evaluateMaterialDecision(id, verdict) 人工回填 Outcome 因果判定
 *  - supersedeMaterialDecision(oldId, in)  更正：新行 supersede 旧行（facts write-once）
 *  - projectMaterialDecisionOutcome(orderId) 只读投影器：算 outcome_auto_signals（service-role）
 *
 * 纪律（对齐 runtime-confidence）：
 *  - flag=off → 全部 no-op（return skipped），不触碰 material_decisions 表（迁移可尚未跑）。
 *  - 捕获/投影 永不抛异常、永不阻塞主链路；表/列缺失 → 静默降级（仿 addBomItem）。
 *  - 价格敏感字段对非 CAN_SEE_PROCUREMENT_FLOOR 角色屏蔽（CLAUDE.md 价格红线）。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { getUserRoles } from '@/lib/utils/user-role';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { knowledgeLayerProjectionEnabled } from '@/lib/engine/featureFlags';
import { computeOutcomeSignals, suggestOutcome } from '@/lib/knowledge/outcome';
import type {
  MaterialDecisionCaptureInput,
  OutcomeResult,
  EvidenceRef,
} from '@/lib/knowledge/types';

const LOG_PREFIX = '[material-decisions]';

/** 表/列尚未建（迁移未跑）→ 降级而非报错 */
function isSchemaMissing(msg?: string | null): boolean {
  return !!msg && /does not exist|could not find|relation .* does not exist|schema cache/i.test(msg);
}

// ────────────────────────────────────────────────────────────
// 1) 捕获
// ────────────────────────────────────────────────────────────

export interface CaptureResult {
  ok: boolean;
  skipped?: boolean;   // flag off / 表未建 / 非关键
  id?: string | null;
  error?: string;
}

export async function captureMaterialDecision(
  input: MaterialDecisionCaptureInput,
): Promise<CaptureResult> {
  try {
    if (!knowledgeLayerProjectionEnabled()) return { ok: true, skipped: true };
    if (!input?.orderId) return { ok: false, error: 'orderId required' };
    if (!input.reasonCode) return { ok: false, error: 'reasonCode required' };

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '请先登录' };
    const roleErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可记录物料决策');
    if (roleErr) return { ok: false, error: roleErr };

    const row: Record<string, any> = {
      order_id: input.orderId,
      bom_id: input.bomId ?? null,
      product_bom_template_id: input.productBomTemplateId ?? null,
      material_master_id: input.materialMasterId ?? null,
      material_name: input.materialName,
      material_code: input.materialCode ?? null,
      decision_type: input.decisionType,
      reason_code: input.reasonCode,
      reason_note: input.reasonNote?.trim() || null,
      before_json: input.before ?? {},
      after_json: input.after ?? {},
      estimated_impact_qty: input.estimatedImpactQty ?? null,
      estimated_impact_amount: input.estimatedImpactAmount ?? null,
      impact_currency: input.impactCurrency ?? null,
      evidence_refs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [],
      scope_json: input.scope ?? null,
      source: 'human',
      actor_id: user.id,
      status: 'confirmed',
    };

    const { data, error } = await (supabase.from('material_decisions') as any)
      .insert(row).select('id').single();

    if (error) {
      if (isSchemaMissing(error.message)) {
        console.warn(LOG_PREFIX, 'table not migrated yet, skip capture:', error.message);
        return { ok: true, skipped: true };   // 迁移未跑 → 静默降级，绝不 brick BOM 保存
      }
      console.error(LOG_PREFIX, 'insert failed:', error.message);
      return { ok: false, error: error.message };
    }

    const decisionId = (data as any)?.id ?? null;

    // append-only 不可变轨迹（复用 order_logs；fire-and-forget，失败忽略）
    try {
      await (supabase.from('order_logs') as any).insert({
        order_id: input.orderId,
        actor_user_id: user.id,
        action: 'material_decision_captured',
        note: `[${input.decisionType}] ${input.materialName} — ${input.reasonCode}`,
        payload: {
          decision_id: decisionId,
          decision_type: input.decisionType,
          reason_code: input.reasonCode,
          bom_id: input.bomId ?? null,
        },
      });
    } catch { /* 轨迹失败不影响决策 */ }

    return { ok: true, id: decisionId };
  } catch (e: any) {
    console.error(LOG_PREFIX, 'capture exception:', e?.message);
    return { ok: false, error: e?.message || 'capture exception' };
  }
}

// ────────────────────────────────────────────────────────────
// 2) 列表（价格屏蔽）
// ────────────────────────────────────────────────────────────

/** 对无采购底价权限的角色，抹掉金额类字段（估算金额 / 成本差信号）。 */
function maskPrice(row: any) {
  const r = { ...row };
  r.estimated_impact_amount = null;
  r.impact_currency = null;
  if (r.outcome_auto_signals && typeof r.outcome_auto_signals === 'object') {
    const sig = { ...r.outcome_auto_signals };
    delete sig.cost_variance_pct;
    r.outcome_auto_signals = sig;
  }
  return r;
}

export async function listMaterialDecisions(orderId: string): Promise<{ data: any[]; error?: string }> {
  try {
    if (!orderId) return { data: [], error: 'orderId required' };
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], error: '请先登录' };

    const { data, error } = await (supabase.from('material_decisions') as any)
      .select('*').eq('order_id', orderId).order('decided_at', { ascending: false });

    if (error) {
      if (isSchemaMissing(error.message)) return { data: [] };   // 表未建 → 空列表，UI 不崩
      return { data: [], error: error.message };
    }

    const roles = await getUserRoles(supabase, user.id);
    const canSeePrice = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
    const rows = (data || []).map((r: any) => (canSeePrice ? r : maskPrice(r)));
    return { data: rows };
  } catch (e: any) {
    return { data: [], error: e?.message || 'list exception' };
  }
}

/** 跨订单最近决策（Learning Center 用；RLS 自动按订单可见性收敛；价格屏蔽）。 */
export async function listRecentMaterialDecisions(limit = 200): Promise<{ data: any[]; canEvaluate: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], canEvaluate: false, error: '请先登录' };

    const { data, error } = await (supabase.from('material_decisions') as any)
      .select('*').order('decided_at', { ascending: false }).limit(limit);
    if (error) {
      if (isSchemaMissing(error.message)) return { data: [], canEvaluate: false };
      return { data: [], canEvaluate: false, error: error.message };
    }

    const roles = await getUserRoles(supabase, user.id);
    const canSeePrice = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
    const rows = (data || []).map((r: any) => (canSeePrice ? r : maskPrice(r)));
    return { data: rows, canEvaluate: canSeePrice };
  } catch (e: any) {
    return { data: [], canEvaluate: false, error: e?.message || 'list exception' };
  }
}

// ────────────────────────────────────────────────────────────
// 3) 人工评估 Outcome
// ────────────────────────────────────────────────────────────

export interface EvaluateVerdict {
  outcomeResult: OutcomeResult;
  wasCorrect: boolean;
  attributedCause?: string | null;
  note?: string | null;
}

export async function evaluateMaterialDecision(
  id: string,
  verdict: EvaluateVerdict,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!id) return { ok: false, error: 'id required' };
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '请先登录' };
    // 材料决策的因果判定归采购/财务/admin（看得到成本才判得了对不对）
    const roleErr = await requireRoleGroup(
      supabase, user.id, 'CAN_SEE_PROCUREMENT_FLOOR', '仅采购/财务/管理员可评估物料决策结果',
    );
    if (roleErr) return { ok: false, error: roleErr };

    const { error } = await (supabase.from('material_decisions') as any).update({
      outcome_result: verdict.outcomeResult,
      outcome_was_correct: verdict.wasCorrect,
      outcome_attributed_cause: verdict.attributedCause?.trim() || null,
      outcome_note: verdict.note?.trim() || null,
      evaluated_by: user.id,
      evaluated_at: new Date().toISOString(),
      status: 'evaluated',
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'evaluate exception' };
  }
}

// ────────────────────────────────────────────────────────────
// 4) 更正（supersede；facts write-once）
// ────────────────────────────────────────────────────────────

export async function supersedeMaterialDecision(
  oldId: string,
  newInput: MaterialDecisionCaptureInput,
): Promise<CaptureResult> {
  try {
    if (!oldId) return { ok: false, error: 'oldId required' };
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '请先登录' };
    const roleErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可更正物料决策');
    if (roleErr) return { ok: false, error: roleErr };

    // 先落新行
    const created = await captureMaterialDecision(newInput);
    if (!created.ok || !created.id) return created;

    // 新行标记 supersede 旧行；旧行置 superseded（旧行事实不改，只改状态）
    try {
      await (supabase.from('material_decisions') as any)
        .update({ supersedes_decision_id: oldId, updated_at: new Date().toISOString() })
        .eq('id', created.id);
      await (supabase.from('material_decisions') as any)
        .update({ status: 'superseded', updated_at: new Date().toISOString() })
        .eq('id', oldId);
    } catch (e: any) {
      console.warn(LOG_PREFIX, 'supersede link failed:', e?.message);
    }
    return created;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'supersede exception' };
  }
}

// ────────────────────────────────────────────────────────────
// 5) Outcome 投影器（只读现有采购表；service-role；永不抛）
// ────────────────────────────────────────────────────────────

export interface ProjectResult { ok: boolean; skipped?: boolean; updated?: number; error?: string }

export async function projectMaterialDecisionOutcome(orderId: string): Promise<ProjectResult> {
  try {
    if (!knowledgeLayerProjectionEnabled()) return { ok: true, skipped: true };
    if (!orderId) return { ok: false, error: 'orderId required' };

    let sys;
    try { sys = createServiceRoleClient(); }
    catch (e: any) { return { ok: false, error: 'service-role unavailable' }; }

    // 拉本单待评估决策
    const { data: decisions, error: dErr } = await (sys.from('material_decisions') as any)
      .select('id, material_name, material_master_id, status')
      .eq('order_id', orderId)
      .in('status', ['confirmed', 'outcome_pending']);
    if (dErr) {
      if (isSchemaMissing(dErr.message)) return { ok: true, skipped: true };
      return { ok: false, error: dErr.message };
    }
    if (!decisions?.length) return { ok: true, updated: 0 };

    // 拉本单采购数据（防列名假设：select *，JS 里按物料匹配、可选链取值）
    const { data: procItems } = await (sys.from('procurement_items') as any).select('*').eq('order_id', orderId);
    const { data: lineItems } = await (sys.from('procurement_line_items') as any).select('*').eq('order_id', orderId);
    const { data: fin } = await (sys.from('order_financials') as any)
      .select('cost_material, cost_material_actual').eq('order_id', orderId).maybeSingle();

    const norm = (v: any) => (v ?? '').toString().trim().toLowerCase();
    const nowIso = new Date().toISOString();
    let updated = 0;

    for (const d of decisions as any[]) {
      const matchName = norm(d.material_name);
      const matchMaster = norm(d.material_master_id);
      const pItems = (procItems || []).filter((p: any) =>
        (matchMaster && norm(p.material_master_id) === matchMaster) ||
        (matchName && norm(p.material_name) === matchName));
      const lItems = (lineItems || []).filter((l: any) =>
        (matchMaster && norm(l.material_master_id) === matchMaster) ||
        (matchName && norm(l.material_name) === matchName));

      const signals = computeOutcomeSignals({
        procurementItems: pItems,
        lineItems: lItems,
        costPlanned: (fin as any)?.cost_material ?? null,
        costActual: (fin as any)?.cost_material_actual ?? null,
        nowIso,
      });
      (signals as any).suggested_result = suggestOutcome(signals);

      const { error: uErr } = await (sys.from('material_decisions') as any).update({
        outcome_auto_signals: signals,
        status: d.status === 'confirmed' ? 'outcome_pending' : d.status,
        updated_at: nowIso,
      }).eq('id', d.id);
      if (!uErr) updated++;
    }

    return { ok: true, updated };
  } catch (e: any) {
    console.error(LOG_PREFIX, 'project exception:', e?.message);
    return { ok: false, error: e?.message || 'project exception' };
  }
}
