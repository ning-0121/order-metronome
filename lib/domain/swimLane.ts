/**
 * Swim Lane — 节点泳道分类
 *
 * 目的：把 30 个里程碑按"主要操作部门"分到 3 条线，
 *      让业务/生产分别只看自己的节点（默认视图），消除"被对方节点视觉堵住"的感受。
 *
 * 核心：lane ≠ 部门所有权。
 *      lane = 该节点"属于谁的日常视野"。
 *      跨部门同步点（如财务审批/QC放行/出运）放在 sync lane，双方都默认看到。
 *
 * 用户可手动切到「全部」查看完整链路（不锁死视图）。
 */

export type SwimLane = 'sales' | 'production' | 'sync';

/**
 * 节点 → 泳道映射
 * 未在表中的 step_key 默认 'sync'（保守：让所有人看到，避免遗漏）
 */
const STEP_LANE_MAP: Record<string, SwimLane> = {
  // ─────────────────────────────────────────────
  // 🔵 业务线（sales）— 客户面动作 + 业务双签
  // ─────────────────────────────────────────────
  po_confirmed:                  'sales',
  production_order_upload:       'sales',
  pre_production_sample_sent:    'sales',  // 业务填快递单号、每日追踪
  pre_production_sample_approved:'sales',  // 客户确认
  mid_qc_sales_check:            'sales',
  shipping_sample_send:          'sales',
  final_qc_sales_check:          'sales',

  // 头样 / 二次样的客户对接也属业务线
  dev_sample_sent:                'sales',
  dev_sample_customer_confirm:    'sales',
  dev_sample_revision_sent:       'sales',
  dev_sample_revision_confirm:    'sales',

  // ─────────────────────────────────────────────
  // 🟠 生产线（production）— 工厂执行、采购、QC 检查
  // ─────────────────────────────────────────────
  order_docs_bom_complete:       'production',
  bulk_materials_confirmed:      'production',
  processing_fee_confirmed:      'production',
  factory_confirmed:             'production',
  pre_production_sample_ready:   'production',
  procurement_order_placed:      'production',
  materials_received_inspected:  'production',
  pre_production_meeting:        'production',
  production_kickoff:            'production',
  mid_qc_check:                  'production',
  packing_method_confirmed:      'production',
  final_qc_check:                'production',
  factory_completion:            'production',
  leftover_collection:           'production',

  // 头样 / 二次样的工厂端
  dev_sample_making:             'production',
  dev_sample_revision:           'production',

  // ─────────────────────────────────────────────
  // 🟣 跨部门同步（sync）— 财务/物流/QC 放行/出运
  // ─────────────────────────────────────────────
  finance_approval:              'sync',
  order_kickoff_meeting:         'sync',
  finished_goods_warehouse:      'sync',
  inspection_release:            'sync',
  booking_done:                  'sync',
  customs_export:                'sync',
  finance_shipment_approval:     'sync',
  shipment_execute:              'sync',
  payment_received:              'sync',
  domestic_delivery:             'sync',
};

/**
 * 获取节点的泳道
 * 未定义的 step_key 默认 'sync'（保守策略：宁可多展示也不漏）
 */
export function getSwimLane(stepKey: string | null | undefined): SwimLane {
  if (!stepKey) return 'sync';
  return STEP_LANE_MAP[stepKey] ?? 'sync';
}

/**
 * 泳道 UI 元数据（中文标签 + Tailwind 颜色 class）
 */
export const LANE_META: Record<SwimLane, {
  label: string;
  shortLabel: string;
  emoji: string;
  dotClass: string;     // 小圆点
  badgeClass: string;   // 完整 badge
  pillClass: string;    // 顶部 filter pill（激活态）
}> = {
  sales: {
    label: '业务线',
    shortLabel: '业务',
    emoji: '🔵',
    dotClass: 'bg-blue-500',
    badgeClass: 'bg-blue-100 text-blue-700',
    pillClass: 'bg-blue-600 text-white',
  },
  production: {
    label: '生产线',
    shortLabel: '生产',
    emoji: '🟠',
    dotClass: 'bg-orange-500',
    badgeClass: 'bg-orange-100 text-orange-700',
    pillClass: 'bg-orange-600 text-white',
  },
  sync: {
    label: '跨部门同步',
    shortLabel: '同步',
    emoji: '🟣',
    dotClass: 'bg-purple-500',
    badgeClass: 'bg-purple-100 text-purple-700',
    pillClass: 'bg-purple-600 text-white',
  },
};

/**
 * 根据用户角色返回默认显示的泳道
 *
 * 规则：
 * - sales / merchandiser     → sales + sync
 * - production / production_manager / procurement / qc → production + sync
 * - logistics                → sync（物流主要在交接点）
 * - finance                  → sync（财务主要在审批点）
 * - admin / admin_assistant  → 全部
 * - 其他/未知                → 全部（保守）
 *
 * 注意：返回的是"默认显示"，不锁死。用户可在 UI 上切到「全部」。
 */
export function getDefaultLanesForRoles(roles: string[]): SwimLane[] {
  const r = roles.map(x => String(x).toLowerCase());

  // admin 看全部
  if (r.includes('admin') || r.includes('admin_assistant')) {
    return ['sales', 'production', 'sync'];
  }

  const lanes = new Set<SwimLane>();
  if (r.includes('sales') || r.includes('merchandiser')) {
    lanes.add('sales');
    lanes.add('sync');
  }
  if (
    r.includes('production') ||
    r.includes('production_manager') ||
    r.includes('procurement') ||
    r.includes('qc') ||
    r.includes('quality')
  ) {
    lanes.add('production');
    lanes.add('sync');
  }
  if (r.includes('logistics') || r.includes('finance')) {
    lanes.add('sync');
  }

  // 兜底：没有匹配到任何角色 → 显示全部（避免空白）
  if (lanes.size === 0) {
    return ['sales', 'production', 'sync'];
  }

  return Array.from(lanes);
}
