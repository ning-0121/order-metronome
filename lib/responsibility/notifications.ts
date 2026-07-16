import type { EffectiveResponsibility } from './service';

export type ResponsibilityEvent = 'production_delay' | 'customer_delay' | 'qc_failure' | 'shipment_blocker';
const TYPES: Record<ResponsibilityEvent, string[]> = {
  production_delay: ['production_manager_owner','business_execution_owner'],
  customer_delay: ['production_manager_owner','business_execution_owner','development_owner'],
  qc_failure: ['production_follow_up_owner','production_manager_owner','business_execution_owner'],
  shipment_blocker: ['logistics_owner','business_execution_owner','production_follow_up_owner','finance_owner'],
};

export function recipientsForResponsibilityEvent(event: ResponsibilityEvent, responsibilities: EffectiveResponsibility[]): string[] {
  const wanted = new Set(TYPES[event]);
  return [...new Set(responsibilities.filter((r) => wanted.has(r.type) && r.userId).map((r) => r.userId!))];
}
