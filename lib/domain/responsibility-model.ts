import { capabilitiesForRoles, type Capability } from '@/lib/os/capabilities';

export type CanonicalResponsibility =
  | 'development_owner'
  | 'business_execution_owner'
  | 'production_manager_owner'
  | 'production_follow_up_owner'
  | 'procurement_owner'
  | 'logistics_owner'
  | 'finance_owner';

export type ApprovalDecision =
  | 'quotation_special_price'
  | 'customer_commitment_change'
  | 'production_delay'
  | 'factory_finalization'
  | 'production_schedule_finalization'
  | 'procurement_concession'
  | 'qc_release'
  | 'payment';

const DECISION_CAPABILITY: Partial<Record<ApprovalDecision, Capability>> = {
  factory_finalization: 'factory.finalize',
  production_schedule_finalization: 'production.schedule.finalize',
  qc_release: 'quality.release',
};

const DECISION_ROLES: Record<ApprovalDecision, readonly string[]> = {
  quotation_special_price: ['sales_manager'],
  customer_commitment_change: ['order_manager', 'sales_manager'],
  production_delay: ['production_manager'],
  factory_finalization: ['production_manager'],
  production_schedule_finalization: ['production_manager'],
  procurement_concession: ['procurement_manager'],
  qc_release: ['production', 'qc', 'quality'],
  payment: ['finance'],
};

export function canApproveDecision(roles: string[], decision: ApprovalDecision): boolean {
  if (roles.includes('admin')) return true;
  const capability = DECISION_CAPABILITY[decision];
  if (capability && !capabilitiesForRoles(roles).has(capability)) return false;
  return roles.some((role) => DECISION_ROLES[decision].includes(role));
}

export function addResponsibility(
  current: Partial<Record<CanonicalResponsibility, string | null>>,
  responsibility: CanonicalResponsibility,
  userId: string,
): Partial<Record<CanonicalResponsibility, string | null>> {
  return { ...current, [responsibility]: userId };
}

export function responsibilitiesAfterHandoff(input: {
  developmentOwner?: string | null;
  executionOwner: string;
}): Partial<Record<CanonicalResponsibility, string | null>> {
  return {
    development_owner: input.developmentOwner ?? null,
    business_execution_owner: input.executionOwner,
  };
}

export function requiredOwnersAtStage(stage: 'po' | 'execution' | 'production' | 'shipment' | 'closed'): CanonicalResponsibility[] {
  if (stage === 'po') return ['development_owner'];
  if (stage === 'execution') return ['business_execution_owner'];
  if (stage === 'production') return ['business_execution_owner', 'production_manager_owner', 'production_follow_up_owner'];
  if (stage === 'shipment') return ['business_execution_owner', 'production_follow_up_owner', 'logistics_owner'];
  return ['business_execution_owner'];
}

export function canSelfApprove(requesterId: string, actorId: string): boolean {
  return requesterId !== actorId;
}

export function validateAdminOverride(input: { roles: string[]; reason?: string | null }): { ok: boolean; error?: string } {
  if (!input.roles.includes('admin')) return { ok: false, error: '仅 CEO/管理员可执行覆盖' };
  if (!input.reason?.trim()) return { ok: false, error: '覆盖必须填写原因并写入审计日志' };
  return { ok: true };
}
