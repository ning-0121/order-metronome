/**
 * QIMO OS — System Registry v2（Phase A+ 治理模型）
 *
 * 治理级系统定义：在 Phase A 基础系统事实（systems.ts）之上叠加治理字段
 * （owner_team / entry_policy / security_level / capability_required / scoped_capabilities）。
 * 单一真相：基础事实来自 systems.ts，治理覆盖在此定义，registry 不重复系统数据。
 *
 * 可见性由 **能力解析** 驱动（capability-driven），非角色白名单直判。
 */

import { OS_SYSTEMS, type OsSystemDef } from './systems';
import { capabilitiesForRoles, type Capability } from './capabilities';

export type EntryPolicy = 'direct' | 'handoff_required';
export type SecurityLevel = 'standard' | 'sensitive';

export interface SystemV2 extends OsSystemDef {
  owner_team: string;
  entry_policy: EntryPolicy;
  security_level: SecurityLevel;
  /** 进入该系统所需能力（全部满足才可见） */
  capability_required: Capability[];
  /** 该系统承认的能力（BridgeSession.scope = userCaps ∩ 此集） */
  scoped_capabilities: Capability[];
  denied_roles: string[];
  external_contract?: string;
}

interface Governance {
  owner_team: string;
  entry_policy: EntryPolicy;
  security_level: SecurityLevel;
  capability_required: Capability[];
  scoped_capabilities: Capability[];
  denied_roles?: string[];
  external_contract?: string;
}

const GOVERNANCE: Record<string, Governance> = {
  araos: {
    owner_team: '开发业务部', entry_policy: 'handoff_required', security_level: 'standard',
    capability_required: ['client.develop'], scoped_capabilities: ['client.develop'],
    external_contract: 'os-external-contract-v1',
  },
  order: {
    owner_team: '订单管理部', entry_policy: 'direct', security_level: 'standard',
    capability_required: ['order.execute'], scoped_capabilities: ['order.execute'],
  },
  procurement: {
    owner_team: '采购部', entry_policy: 'direct', security_level: 'standard',
    capability_required: ['procurement.manage'], scoped_capabilities: ['procurement.manage'],
  },
  production: {
    owner_team: '生产部', entry_policy: 'direct', security_level: 'standard',
    capability_required: ['production.manage'], scoped_capabilities: ['production.manage'],
  },
  finance: {
    owner_team: '财务部', entry_policy: 'handoff_required', security_level: 'sensitive',
    capability_required: ['finance.view'], scoped_capabilities: ['finance.view'],
    external_contract: 'os-external-contract-v1',
  },
};

/** 治理注册表（基础事实 × 治理覆盖）。 */
export const SYSTEM_REGISTRY: SystemV2[] = OS_SYSTEMS.map((s: OsSystemDef) => {
  const g = GOVERNANCE[s.id];
  if (!g) throw new Error(`registry: missing governance for system '${s.id}'`);
  return { ...s, ...g, denied_roles: g.denied_roles ?? [] };
});

/** 能力驱动的可见性（+ denied_roles 硬否决）。 */
export function resolveVisibleSystems(
  roles: string[] | null | undefined,
  registry: SystemV2[] = SYSTEM_REGISTRY,
): SystemV2[] {
  const caps = capabilitiesForRoles(roles);
  const rolesArr = roles ?? [];
  return registry.filter(
    (s) =>
      s.capability_required.every((c) => caps.has(c)) &&
      !s.denied_roles.some((r) => rolesArr.includes(r)),
  );
}

export function getSystem(systemId: string, registry: SystemV2[] = SYSTEM_REGISTRY): SystemV2 | undefined {
  return registry.find((s) => s.id === systemId);
}

export function canAccessSystem(
  systemId: string,
  roles: string[] | null | undefined,
  registry: SystemV2[] = SYSTEM_REGISTRY,
): boolean {
  return resolveVisibleSystems(roles, registry).some((s) => s.id === systemId);
}

/** 进入路径：direct → 应用路径；handoff_required → 受控跳转端点。 */
export function resolveEntry(s: SystemV2): string {
  return s.entry_policy === 'direct' ? (s.internalPath ?? '/') : `/api/os/handoff?target=${s.id}`;
}

/** 目标系统的 scope：用户能力 ∩ 系统承认能力（per-system 限缩）。 */
export function scopeForSystem(
  systemId: string,
  roles: string[] | null | undefined,
  registry: SystemV2[] = SYSTEM_REGISTRY,
): Capability[] {
  const s = getSystem(systemId, registry);
  if (!s) return [];
  const caps = capabilitiesForRoles(roles);
  return s.scoped_capabilities.filter((c) => caps.has(c));
}
