/**
 * QIMO OS — 系统注册表（Unified Access Layer · Phase A）
 *
 * 声明式"系统 × 可进角色"映射（只做第一层：能否进模块）。
 * 角色值取自 lib/domain/roles.ts，不新增角色、不碰 DB。
 * internal = QIMO 本 app 路由（已登录，直接进）；external = 独立 repo，走受控跳转/短时 token。
 *
 * 后续如发现角色名与 roles.ts 不一致，以 roles.ts 为准做最小映射（不新增角色）。
 */

export type SystemKind = 'internal' | 'external';

export interface OsSystemDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  kind: SystemKind;
  /** internal：QIMO app 路径 */
  internalPath?: string;
  /** external：存基址的 env 变量名（运行时解析，不写死 URL） */
  urlEnvKey?: string;
  /** 可进该系统的角色（Phase A 只做"模块显示权限"） */
  allowRoles: string[];
}

/** Phase A 初版映射（用户 §7 拍板） */
export const OS_SYSTEMS: OsSystemDef[] = [
  {
    id: 'araos', name: '业务开发系统', desc: '客户开发 / 商机 / 报价前',
    icon: '🧲', kind: 'external', urlEnvKey: 'OS_ARAOS_URL',
    allowRoles: ['sales', 'sales_manager', 'admin'],
  },
  {
    id: 'order', name: '订单执行系统', desc: '订单 18 关卡执行',
    icon: '📦', kind: 'internal', internalPath: '/dashboard',
    allowRoles: ['sales', 'merchandiser', 'production', 'order_manager', 'admin'],
  },
  {
    id: 'procurement', name: '采购系统', desc: '采购单 / 供应商 / 物料',
    icon: '🛒', kind: 'internal', internalPath: '/procurement',
    allowRoles: ['procurement', 'procurement_manager', 'finance', 'admin'],
  },
  {
    id: 'production', name: '生产系统', desc: '大货生产 / 品控',
    icon: '🏭', kind: 'internal', internalPath: '/factories',
    allowRoles: ['production', 'qc', 'production_manager', 'merchandiser', 'admin'],
  },
  {
    id: 'finance', name: '财务系统', desc: '预算 / 成本 / 对账',
    icon: '💰', kind: 'external', urlEnvKey: 'OS_FINANCE_URL',
    allowRoles: ['finance', 'admin'],
  },
];

/** 纯过滤：给定角色，返回可进系统（敏感系统对无权角色不出现）。 */
export function visibleSystemsForRoles(
  roles: string[] | null | undefined,
  systems: OsSystemDef[] = OS_SYSTEMS,
): OsSystemDef[] {
  if (!roles || roles.length === 0) return [];
  return systems.filter((s) => s.allowRoles.some((r) => roles.includes(r)));
}

/** 单系统门控（受控跳转前的服务端校验用）。 */
export function canEnterSystem(
  systemId: string,
  roles: string[] | null | undefined,
  systems: OsSystemDef[] = OS_SYSTEMS,
): boolean {
  if (!roles || roles.length === 0) return false;
  const s = systems.find((x) => x.id === systemId);
  if (!s) return false;
  return s.allowRoles.some((r) => roles.includes(r));
}

/** 卡片跳转目标：internal → 应用路径；external → 走 handoff（服务端铸 token/跳转）。 */
export function resolveHref(s: OsSystemDef): string {
  return s.kind === 'internal' ? (s.internalPath ?? '/') : `/api/os/handoff?target=${s.id}`;
}
