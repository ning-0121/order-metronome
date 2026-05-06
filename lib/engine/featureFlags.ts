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

/** 调试/审计辅助：导出当前所有 flag 状态 */
export function getEngineFlags() {
  return {
    rootCauseEngine: rootCauseEngineEnabled(),
    businessDecisionEngine: businessDecisionEngineEnabled(),
    dataAssetLayer: dataAssetLayerEnabled(),
    runtimeConfidenceMode: runtimeConfidenceMode(),
  };
}
