export type ClosureCondition = { shipmentCompleted: boolean; businessExecutionConfirmed: boolean; exceptionsResolvedOrAccepted: boolean; financeSatisfied: boolean; evidenceComplete: boolean };
export function evaluateOrderClosure(input: ClosureCondition) {
  const blockers: string[] = [];
  if (!input.shipmentCompleted) blockers.push('shipment');
  if (!input.businessExecutionConfirmed) blockers.push('business_execution');
  if (!input.exceptionsResolvedOrAccepted) blockers.push('exceptions');
  if (!input.financeSatisfied) blockers.push('finance');
  if (!input.evidenceComplete) blockers.push('evidence');
  return { allowed: blockers.length === 0, blockers };
}
