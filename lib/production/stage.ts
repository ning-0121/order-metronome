/**
 * 生产阶段口径(单一真相)——被 生产中心 与 生产主管一次性进度初始化 共用。
 * 纯函数,无 IO。改这里等于同时改两处,避免两套口径漂移。
 */

export type ProductionStage =
  | 'awaiting_procurement'
  | 'materials_in_transit'
  | 'ready_to_schedule'
  | 'in_production'
  | 'ready_to_ship';

export interface MaterialReadiness {
  total: number;
  received: number;
  in_transit: number;
  pending: number;
}

export interface StageNode {
  status: string | null;
  due: string | null;
}

/** 阶段从早到晚的顺序(用于「取更靠后的阶段」做手动档下限)。'done' 视为最靠后。 */
export const STAGE_ORDER: ProductionStage[] = [
  'awaiting_procurement',
  'materials_in_transit',
  'ready_to_schedule',
  'in_production',
  'ready_to_ship',
];

export const STAGE_LABEL: Record<ProductionStage, string> = {
  awaiting_procurement: '新订单待采购',
  materials_in_transit: '物料在途',
  ready_to_schedule: '开生产待排单',
  in_production: '生产中',
  ready_to_ship: '待发货',
};

export const DONE = (s: string | null | undefined) =>
  ['done', 'completed', '已完成'].includes(String(s || '').toLowerCase());

export const RECEIVED = new Set(['received', 'accepted', 'closed', 'concession']);
export const IN_TRANSIT = new Set(['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived']);
export const NOT_SECURED = new Set(['draft', 'pending_order']);

/**
 * 依 物料就绪 + 生产节点 自动推算订单当前阶段。
 * 返回 'done' 表示工厂已完工/已出运 → 离开生产中心。
 */
export function computeStage(
  m: MaterialReadiness,
  kickoff: StageNode | null,
  factoryDone: { status: string | null } | null,   // 尾查/工厂完成(完工信号)
  shipped: { status: string | null } | null,        // 发货出运(出运信号)
  procPlaced?: { status: string | null } | null,    // 采购下单里程碑(线级采购数据缺失时的兜底信号)
): ProductionStage | 'done' {
  if (shipped && DONE(shipped.status)) return 'done';         // 已出运 → 出生产中心
  if (kickoff && DONE(kickoff.status)) {
    // 已开裁:工厂已完工(尾查/工厂完成)但未出运 → 待发货;否则还在生产中
    if (factoryDone && DONE(factoryDone.status)) return 'ready_to_ship';
    return 'in_production';
  }
  if (m.total === 0) {
    // 无采购执行行(老单/没走线级采购,只在里程碑标了采购下单)→ 退回看「采购下单」里程碑
    if (procPlaced && DONE(procPlaced.status)) return 'materials_in_transit';
    return 'awaiting_procurement';                             // 未起料且采购未下单 → 待采购
  }
  if (m.received === m.total) return 'ready_to_schedule';      // 全到齐未开裁 → 待排单
  if (m.in_transit > 0 || m.received > 0) return 'materials_in_transit'; // 有料在途/部分到齐
  return 'awaiting_procurement';                               // 全部还没下单 → 待采购
}

/** 阶段序号:数字越大越靠后;'done' 最大。用于取「手动档 vs 自动档」中更靠后的一个。 */
export function stageRank(s: ProductionStage | 'done'): number {
  if (s === 'done') return STAGE_ORDER.length;
  return STAGE_ORDER.indexOf(s);
}

/**
 * 生效阶段 = 手动档与自动档中「更靠后」的一个。
 * 手动档只做下限:主管设了「生产中」后,系统自动推算永远不会把它拉回「待采购」,
 * 但一旦真实节点推进到比手动档更靠后(如工厂完工→done),自动档接管往前走。
 */
export function effectiveStage(
  auto: ProductionStage | 'done',
  manual: ProductionStage | 'done' | null | undefined,
): ProductionStage | 'done' {
  if (!manual) return auto;
  return stageRank(manual) >= stageRank(auto) ? manual : auto;
}

/** 手动档合法值(含 done)。用于校验入参。 */
export const MANUAL_STAGE_VALUES: (ProductionStage | 'done')[] = [...STAGE_ORDER, 'done'];

/** 手动选档下拉项(5 档 + 已完工)。 */
export const STAGE_INIT_OPTIONS: { value: ProductionStage | 'done'; label: string }[] = [
  ...STAGE_ORDER.map((value) => ({ value, label: STAGE_LABEL[value] })),
  { value: 'done' as const, label: '工厂已完工(出中心)' },
];
