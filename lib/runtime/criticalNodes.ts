/**
 * Runtime Engine Phase 1 — Critical Nodes 模块
 *
 * 不做完整 DAG。先用一份"对最终交付有直接影响"的关键节点清单。
 * 非关键节点（如确认链单项、附件类）即使延期也不直接拉低 confidence。
 *
 * 这些常量将被：
 *  - lib/runtime/deliveryConfidence.ts 用于扣分判定
 *  - lib/engine/orderBusinessEngine.ts 用于 next_blocker 识别（已用）
 */

/** 关键路径节点 step_key 集合 */
export const CRITICAL_STEP_KEYS = new Set<string>([
  'finance_approval',
  'procurement_order_placed',
  'pre_production_sample_approved',
  'production_kickoff',
  'final_qc_check',
  'factory_completion',
  'booking_done',         // 出口订单的最后阻塞点
  'domestic_delivery',    // 国内送仓订单的最后阻塞点
]);

/** 节点权重（影响 confidence 扣分时使用） */
export const STEP_WEIGHT: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  // 关键路径
  finance_approval:                'critical',
  procurement_order_placed:        'high',
  pre_production_sample_approved:  'high',
  production_kickoff:              'critical',
  final_qc_check:                  'high',
  factory_completion:              'critical',
  booking_done:                    'critical',
  domestic_delivery:               'critical',

  // 次要但有影响
  mid_qc_check:                    'medium',
  packing_method_confirmed:        'medium',
  shipping_sample_send:            'medium',
  inspection_release:              'medium',
  materials_received_inspected:    'medium',
  procurement_order_approval:      'high',

  // 流程辅助（默认 low）
  // 其它节点不在此 map 中 → 视为 low
};

/** 出运/送仓节点（用于判断货物是否已离厂） */
export const SHIPMENT_STEP_KEYS = new Set<string>([
  'booking_done',
  'shipment_execute',
  'customs_export',
  'domestic_delivery',
  'shipment_completed',
  'shipment_done',
]);

/**
 * 取节点的影响权重（默认 low）
 */
export function getStepWeight(stepKey: string): 'critical' | 'high' | 'medium' | 'low' {
  return STEP_WEIGHT[stepKey] || 'low';
}

/**
 * 判断节点是否在关键路径上
 */
export function isCriticalStep(stepKey: string): boolean {
  return CRITICAL_STEP_KEYS.has(stepKey);
}

/**
 * 判断节点是否是出运/送仓节点
 */
export function isShipmentStep(stepKey: string): boolean {
  return SHIPMENT_STEP_KEYS.has(stepKey);
}
