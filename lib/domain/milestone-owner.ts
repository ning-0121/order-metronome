import { BUSINESS_EXECUTION_FIXED_STEPS } from '@/lib/milestoneTemplate';

const BUSINESS_FIXED = new Set<string>(BUSINESS_EXECUTION_FIXED_STEPS as readonly string[]);

export function isBusinessExecutionFixedStep(stepKey: string | null | undefined): boolean {
  return BUSINESS_FIXED.has(String(stepKey || ''));
}

export function effectiveMilestoneOwner<T extends { step_key?: string; owner_role?: string | null; owner_user_id?: string | null }>(
  milestone: T,
  order: { owner_user_id?: string | null; created_by?: string | null },
): T & { owner_role: string; owner_user_id: string | null } {
  if (!isBusinessExecutionFixedStep(milestone.step_key)) return milestone as T & { owner_role: string; owner_user_id: string | null };
  return { ...milestone, owner_role: 'merchandiser', owner_user_id: order.owner_user_id || order.created_by || null };
}
