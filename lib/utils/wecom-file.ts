/**
 * 企业微信群机器人 — 发送文件（方案B：免可信IP，复用 WECOM_WEBHOOK_URL 的 key）
 *
 * 为什么走这条：微盘服务端 API 要求"可信IP"白名单 + ICP 域名，而我们部署在 Vercel
 * （出口 IP 动态），加不进白名单。群机器人的 upload_media 用 webhook 的 key 鉴权，
 * 不需要可信IP，是当前架构下"订单文件直达企业微信"的最省事路径。
 * 团队成员在群里收到文件后可一键转存到个人/共享微盘。
 *
 * 流程：upload_media 拿 media_id（有效3天）→ 发 msgtype:file 消息。
 * 约束：单文件 5B–20MB（群机器人硬限制）；超限自动跳过并回退发一条文本说明。
 * 永不抛错：失败返回 {ok:false, reason}，绝不阻塞主链路（订单/文档流程）。
 */

import { sendWecomWebhook } from './wechat-push';

const QYAPI_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook';
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 群机器人上限 20MB
const MIN_FILE_BYTES = 5;                // 群机器人下限 5B

export function wecomGroupConfigured(): boolean {
  return !!process.env.WECOM_WEBHOOK_URL;
}

function getWebhookKey(): string | null {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('key');
  } catch {
    return null;
  }
}

function toBuffer(content: Buffer | Uint8Array | ArrayBuffer | string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'base64'); // 约定：字符串=base64
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content as any); // Uint8Array | ArrayBuffer 都被 Buffer.from 接受
}

async function uploadMedia(
  key: string, buf: Buffer, filename: string,
): Promise<{ media_id?: string; error?: string }> {
  const form = new FormData();
  form.append('media', new Blob([buf], { type: 'application/octet-stream' }), filename);
  const res = await fetch(
    `${QYAPI_WEBHOOK_BASE}/upload_media?key=${encodeURIComponent(key)}&type=file`,
    { method: 'POST', body: form },
  );
  const json: any = await res.json().catch(() => ({}));
  if (json.errcode === 0 && json.media_id) return { media_id: json.media_id };
  return { error: json.errmsg || `upload_media 失败(errcode=${json.errcode ?? '?'})` };
}

/**
 * 发送一个文件到企业微信群。
 * @param file.content Buffer / Uint8Array / ArrayBuffer / base64 字符串
 * @param opts.caption 可选：先发一条文本卡片（订单号/单据名）作为上下文
 */
export async function pushFileToWecomGroup(
  file: { content: Buffer | Uint8Array | ArrayBuffer | string; filename: string },
  opts?: { caption?: string },
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  try {
    const key = getWebhookKey();
    if (!key) return { ok: false, skipped: true, reason: '未配置 WECOM_WEBHOOK_URL' };

    const buf = toBuffer(file.content);
    if (buf.byteLength < MIN_FILE_BYTES) return { ok: false, skipped: true, reason: '文件过小' };
    if (buf.byteLength > MAX_FILE_BYTES) {
      if (opts?.caption) {
        await sendWecomWebhook(opts.caption, `⚠️ 文件「${file.filename}」超过 20MB，无法直接发群，请到系统内下载。`);
      }
      return { ok: false, skipped: true, reason: '超过20MB，已回退文本提示' };
    }

    // 先发上下文文本（best-effort，不影响文件发送）
    if (opts?.caption) await sendWecomWebhook(opts.caption, `📎 ${file.filename}`);

    const up = await uploadMedia(key, buf, file.filename);
    if (up.error || !up.media_id) return { ok: false, reason: up.error };

    const res = await fetch(process.env.WECOM_WEBHOOK_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'file', file: { media_id: up.media_id } }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json.errcode === 0) return { ok: true };
    return { ok: false, reason: json.errmsg || `发送文件失败(errcode=${json.errcode ?? '?'})` };
  } catch (e: any) {
    return { ok: false, reason: e?.message };
  }
}
