/**
 * QIMO OS — Decision Kernel v1（系统世界的裁判函数）
 *
 * 所有系统访问控制的**唯一决策入口**：hub / handoff / API 都调它，各自不再自判权限。
 *   OSDecisionKernel(user, action) → KernelDecision
 *
 * 设计原则（关键）：Kernel 是**纯函数决策**——它编排 registry + capability + scope，
 * 输出裁决 + tokenScope；但**不铸签名令牌**。令牌铸造需要 per-target env 密钥 + 时间 +
 * jti/nonce（副作用/随机），这些留在边缘（handoff route）执行，Kernel 保持纯净、可测、可审计。
 * fail-closed：未知系统 / 无权 / 缺配 → BLOCKED。
 */

import { resolveVisibleSystems, getSystem, scopeForSystem, type SystemV2 } from './registry';
import { capabilitiesForRoles, type Capability } from './capabilities';

export type EntryMode = 'internal' | 'handoff' | 'blocked';

export type KernelActionType = 'ENTER_SYSTEM' | 'HANDOFF' | 'API_CALL';

export interface KernelInput {
  user: { id: string; email: string; roles: string[] };
  action?: { type: KernelActionType; targetSystem?: string; resource?: string };
  context?: { ip?: string; device?: string };
}

export interface KernelDecision {
  allow: boolean;
  reason: string;
  /** 可见系统集合（hub 渲染用） */
  systemAccess: SystemV2[];
  capabilities: Capability[];
  entryMode: EntryMode;
  targetSystem?: string;
  /** entryMode='handoff' 时，供边缘铸令牌的 per-system 限缩 scope（Kernel 不铸令牌本身） */
  tokenScope?: Capability[];
}

export function OSDecisionKernel(input: KernelInput): KernelDecision {
  const roles = input?.user?.roles ?? [];
  const capabilities = [...capabilitiesForRoles(roles)];
  const systemAccess = resolveVisibleSystems(roles);

  const target = input?.action?.targetSystem;

  // 无目标动作 → Hub 视图（列可见系统）
  if (!target) {
    return { allow: true, reason: 'hub_view', systemAccess, capabilities, entryMode: 'internal' };
  }

  // fail-closed：未知系统
  if (!getSystem(target)) {
    return { allow: false, reason: 'unknown_system', systemAccess, capabilities, entryMode: 'blocked', targetSystem: target };
  }

  // 唯一权威可见性判定：目标必须在可见集合内（能力门 + denied_roles 已在 registry 编码）
  const system = systemAccess.find((s) => s.id === target);
  if (!system) {
    return { allow: false, reason: 'insufficient_permission', systemAccess, capabilities, entryMode: 'blocked', targetSystem: target };
  }

  // 入口模式：direct → 内部直达
  if (system.entry_policy === 'direct') {
    return { allow: true, reason: 'internal_access', systemAccess, capabilities, entryMode: 'internal', targetSystem: target };
  }

  // handoff_required → 授予受控跳转；tokenScope 供边缘铸 BridgeSession
  return {
    allow: true,
    reason: 'handoff_granted',
    systemAccess,
    capabilities,
    entryMode: 'handoff',
    targetSystem: target,
    tokenScope: scopeForSystem(target, roles),
  };
}
