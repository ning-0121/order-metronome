import { randomUUID } from 'node:crypto';

const EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'pdf']);
const ORDER_ID = /^[a-zA-Z0-9_-]+$/;

export function techConfirmObjectKey(orderId: string, originalName: string, uuid = randomUUID()): string {
  if (!ORDER_ID.test(orderId)) throw new Error('INVALID_ORDER_ID');
  if (originalName.includes('/') || originalName.includes('\\') || originalName.includes('\0')) {
    throw new Error('INVALID_FILE_NAME');
  }
  const match = originalName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match?.[1] || '';
  if (!EXTENSIONS.has(ext)) throw new Error('UNSUPPORTED_FILE_TYPE');
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error('INVALID_UUID');
  return `${orderId}/tech-confirm/${uuid}.${ext === 'jpeg' ? 'jpg' : ext}`;
}
