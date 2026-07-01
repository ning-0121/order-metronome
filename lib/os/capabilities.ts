/**
 * QIMO OS — Capability Graph（Phase A+ 治理层）
 *
 * 抽象链：role → capability → system。角色取自 lib/domain/roles.ts，无 DB 变更。
 * 系统可见性不再由"角色白名单"直判，而由"能力解析"驱动（registry.ts 消费）。
 *
 * 设计校准：本映射复现 Phase A 的系统可见性（registry 驱动 == Phase A 行为），
 * 只是把"角色→系统"升级为"角色→能力→系统"，无行为回归。
 */

export type Capability =
  | 'client.develop' // 业务开发（araos）
  | 'order.execute' // 订单执行
  | 'procurement.manage' // 采购
  | 'production.manage' // 生产/品控
  | 'finance.view'; // 财务

export const ALL_CAPABILITIES: Capability[] = [
  'client.develop',
  'order.execute',
  'procurement.manage',
  'production.manage',
  'finance.view',
];

/** 角色 → 能力（种子，可调；不新增角色、不碰 DB）。 */
export const ROLE_CAPABILITIES: Record<string, Capability[]> = {
  admin: [...ALL_CAPABILITIES],
  sales: ['client.develop', 'order.execute'],
  sales_manager: ['client.develop', 'order.execute'],
  merchandiser: ['order.execute', 'production.manage'],
  order_manager: ['order.execute'],
  production: ['order.execute', 'production.manage'],
  production_manager: ['production.manage'],
  qc: ['production.manage'],
  procurement: ['procurement.manage'],
  procurement_manager: ['procurement.manage'],
  finance: ['finance.view', 'procurement.manage'],
};

/** 角色集合 → 能力集合（并集）。 */
export function capabilitiesForRoles(roles: string[] | null | undefined): Set<Capability> {
  const set = new Set<Capability>();
  if (!roles) return set;
  for (const r of roles) {
    for (const c of ROLE_CAPABILITIES[r] ?? []) set.add(c);
  }
  return set;
}
