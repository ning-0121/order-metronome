/**
 * Milestone Hard Dependencies (V1.1)
 *
 * Defines blocking dependencies between milestones.
 * A milestone cannot be marked as done unless all its dependencies are satisfied.
 */

export interface MilestoneDependency {
  // The step_key that is blocked
  stepKey: string;
  // The step_key that must be completed first
  dependsOn: string;
  // Whether the dependency milestone must have required evidence uploaded
  requiresEvidence: boolean;
  // Error message when dependency is not satisfied (Chinese)
  errorMessage: string;
}

/**
 * Hard dependencies: milestone A cannot be completed until milestone B is done
 */
export const MILESTONE_DEPENDENCIES: MilestoneDependency[] = [
  // booking_done depends on ship_sample_approved
  {
    stepKey: 'booking_done',
    dependsOn: 'ship_sample_approved',
    requiresEvidence: true,
    errorMessage: '订舱完成前，必须先完成「客户确认船样」并上传客户确认文件。',
  },
  // ship_sample_approved depends on ship_sample_sent
  {
    stepKey: 'ship_sample_approved',
    dependsOn: 'ship_sample_sent',
    requiresEvidence: true,
    errorMessage: '客户确认船样前，必须先完成「船样寄出」并上传快递单据。',
  },
  // production_start depends on pps_customer_approved
  {
    stepKey: 'production_start',
    dependsOn: 'pps_customer_approved',
    requiresEvidence: true,
    errorMessage: '生产启动前，必须先完成「产前样客户确认」并上传客户确认文件。',
  },
];

/**
 * Get all dependencies for a given step_key
 */
export function getDependenciesForStep(stepKey: string): MilestoneDependency[] {
  return MILESTONE_DEPENDENCIES.filter(dep => dep.stepKey === stepKey);
}

/**
 * Check if a step_key has any blocking dependencies
 */
export function hasBlockingDependencies(stepKey: string): boolean {
  return MILESTONE_DEPENDENCIES.some(dep => dep.stepKey === stepKey);
}

/**
 * Get the step_keys that depend on a given step_key
 */
export function getDependentsOfStep(stepKey: string): string[] {
  return MILESTONE_DEPENDENCIES
    .filter(dep => dep.dependsOn === stepKey)
    .map(dep => dep.stepKey);
}
