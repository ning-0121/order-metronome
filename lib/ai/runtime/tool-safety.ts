import type { ToolSafetyLevel } from './contracts';

export interface ToolAuthorization {
  scene: string;
  safetyLevel: ToolSafetyLevel;
  approvedByHuman?: boolean;
}

export function assertToolAuthorized(input: ToolAuthorization): void {
  if (input.safetyLevel === 'FORBIDDEN') throw new Error('Tool execution is forbidden');
  if (input.scene.startsWith('finance.') && input.safetyLevel === 'WRITE_REQUIRES_APPROVAL') {
    throw new Error('Finance AI paths cannot execute writes; produce a draft for human approval');
  }
  if (input.safetyLevel === 'WRITE_REQUIRES_APPROVAL' && !input.approvedByHuman) {
    throw new Error('Tool write requires explicit human approval');
  }
}

export async function executeAuthorizedTool<T>(
  authorization: ToolAuthorization,
  handler: () => T | Promise<T>,
): Promise<T> {
  assertToolAuthorized(authorization);
  return handler();
}
