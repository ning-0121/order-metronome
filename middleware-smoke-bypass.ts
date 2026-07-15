const SMOKE_PATH = '/api/internal/ai-runtime-smoke';

export function shouldBypassForPreviewSmoke(input: {
  environment?: string;
  method: string;
  pathname: string;
}): boolean {
  return input.environment === 'preview'
    && input.method === 'POST'
    && input.pathname === SMOKE_PATH;
}
