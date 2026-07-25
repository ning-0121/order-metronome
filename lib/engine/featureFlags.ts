/**
 * 经营引擎 Feature Flag
 *
 * 三个开关默认全部 OFF，上线后由管理员逐个开启。
 * env 优先；env 未设置时返回 false（保守）。
 *
 * 用法：
 *   if (rootCauseEngineEnabled()) { ... }
 */

export function rootCauseEngineEnabled(): boolean {
  return process.env.ENGINE_ROOT_CAUSE === 'true';
}

export function businessDecisionEngineEnabled(): boolean {
  return process.env.ENGINE_BUSINESS_DECISION === 'true';
}

export function dataAssetLayerEnabled(): boolean {
  return process.env.ENGINE_DATA_ASSET === 'true';
}

/**
 * Runtime Engine Phase 1 — Delivery Confidence
 *
 * 三态：
 *  - 'off'   : 完全关闭，UI 显示老风险卡（默认）
 *  - 'admin' : 仅 admin 看到新 confidence 卡（灰度）
 *  - 'on'    : 全员开启
 *
 * 控制：env RUNTIME_CONFIDENCE_ENGINE = off | admin | on
 */
export type RuntimeConfidenceMode = 'off' | 'admin' | 'on';

export function runtimeConfidenceMode(): RuntimeConfidenceMode {
  const v = (process.env.RUNTIME_CONFIDENCE_ENGINE || 'off').toLowerCase();
  if (v === 'on' || v === 'admin') return v;
  return 'off';
}

/** 当前用户是否能看到新 confidence 卡（按 mode + isAdmin 判定） */
export function runtimeConfidenceVisible(isAdmin: boolean): boolean {
  const mode = runtimeConfidenceMode();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (mode === 'admin') return !!isAdmin;
  return false;
}

/** 是否启用 runtime 事件投影（写入 runtime_events / runtime_orders） */
export function runtimeProjectionEnabled(): boolean {
  // 投影本身只要 mode != off 就开（积累数据），UI 显示由 visible 控制
  return runtimeConfidenceMode() !== 'off';
}

/**
 * Knowledge Layer K1 — Material Decision Capture
 *
 * 三态（同 Runtime Confidence 灰度范式）：
 *  - 'off'   : 完全关闭（默认）。BomTab 不弹结构化捕获、投影器 5ms 内跳过、
 *              捕获动作 no-op。material_decisions 表可以尚未建（迁移未跑），零影响。
 *  - 'admin' : 仅 admin 看到 / 触发 Decision Capture（灰度）。
 *  - 'on'    : 全员（受 CAN_EDIT_BOM + RLS 限制）。
 *
 * 控制：env KNOWLEDGE_LAYER_CAPTURE = off | admin | on
 */
export type KnowledgeLayerMode = 'off' | 'admin' | 'on';

export function knowledgeLayerMode(): KnowledgeLayerMode {
  const v = (process.env.KNOWLEDGE_LAYER_CAPTURE || 'off').toLowerCase();
  if (v === 'on' || v === 'admin') return v;
  return 'off';
}

/** 当前用户是否能看到 / 触发结构化 Decision Capture（按 mode + isAdmin 判定） */
export function knowledgeLayerCaptureVisible(isAdmin: boolean): boolean {
  const mode = knowledgeLayerMode();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (mode === 'admin') return !!isAdmin;
  return false;
}

/** 是否写入 material_decisions / 跑 Outcome 投影（mode != off 即积累数据） */
export function knowledgeLayerProjectionEnabled(): boolean {
  return knowledgeLayerMode() !== 'off';
}

