import type { EffectiveResponsibility } from './service';

export type ResponsibilityEvent = 'production_delay' | 'customer_delay' | 'qc_failure' | 'material_shortage' | 'shipment_blocker';
export const MANAGER_FALLBACK_ROLES:Partial<Record<ResponsibilityEvent,string[]>>={
  production_delay:['production_manager'],
  customer_delay:['production_manager','order_manager','sales_manager'],
  qc_failure:['production_manager','order_manager'],
  material_shortage:['procurement_manager','production_manager','order_manager'],
};

export function fallbackRolesForShipmentBlockers(blockers:Array<{key:string}>):string[]{
  const map:Record<string,string[]>={
    business_execution:['order_manager'],qc:['production_manager'],logistics:['logistics'],
    finance:['finance'],documents:['order_manager'],packing:['logistics'],
  };
  return [...new Set(blockers.flatMap((b)=>map[b.key]||[]))];
}
const TYPES: Record<ResponsibilityEvent, string[]> = {
  production_delay: ['production_manager_owner','business_execution_owner'],
  customer_delay: ['production_manager_owner','business_execution_owner','development_owner'],
  qc_failure: ['production_follow_up_owner','production_manager_owner','business_execution_owner'],
  material_shortage: ['procurement_owner','production_manager_owner','production_follow_up_owner','business_execution_owner'],
  shipment_blocker: ['logistics_owner','business_execution_owner','production_follow_up_owner','finance_owner'],
};

export function recipientsForResponsibilityEvent(event: ResponsibilityEvent, responsibilities: EffectiveResponsibility[]): string[] {
  const wanted = new Set(TYPES[event]);
  return [...new Set(responsibilities.filter((r) => wanted.has(r.type) && r.userId).map((r) => r.userId!))];
}
