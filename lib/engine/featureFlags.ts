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

/** 调试/审计辅助：导出当前所有 flag 状态 */
export function getEngineFlags() {
  return {
    rootCauseEngine: rootCauseEngineEnabled(),
    businessDecisionEngine: businessDecisionEngineEnabled(),
    dataAssetLayer: dataAssetLayerEnabled(),
  };
}
