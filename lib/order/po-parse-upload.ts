'use client';

/**
 * PO 识别的「直传通道」(2026-08-06)。
 *
 * 【为什么不直接把文件 POST 给 Server Action】两个独立的坑,都在 8-05/8-06 真实撞过:
 *   1. Vercel 平台对函数请求体的硬上限 4.5MB —— 超了平台直接 413,函数不执行
 *   2. 跨境链路对「浏览器→Vercel 的大 POST」不友好 —— CEO 一份 ~MB 级 PDF
 *      连续两天解析失败,服务器侧**连一条日志都没有**(请求根本没到函数),
 *      而同一时段、同一办公室的**附件直传云存储全部成功**。
 *
 * 所以照抄附件那条被证明通的路:浏览器直传 Supabase Storage(order-docs 桶,
 * 任何登录用户可传,与 MilestoneActions 同款),Server Action 只收一个几十字节的
 * 存储路径,再由服务端用 service-role 从存储把文件取回来解析。
 * POST 体从几 MB 变成几十字节 —— 平台上限和跨境大 POST 两个问题一起消失。
 *
 * 上传失败时调用方应回退老路(直接 POST 文件,受 4MB 闸约束)—— 别因为新通道
 * 出问题就把功能整个堵死。
 */

import { createClient } from '@/lib/supabase/client';

export const PO_PARSE_STORAGE_BUCKET = 'order-docs';
/** 专用前缀,便于识别与定期清理;解析完服务端会即删,这里只是兜底标识 */
export const PO_PARSE_STORAGE_PREFIX = 'po-parse-inbox';

/** 存储通道自己的上限 —— 不再受 Vercel 4.5MB 约束,对齐附件的 10MB 口径 */
export const PO_PARSE_STORAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface PoUploadResult {
  ok: boolean;
  /** 成功时:存储内路径,交给 parsePO 的 storage_path 字段 */
  path?: string;
  error?: string;
}

/** 把 PO 文件直传到云存储,返回存储路径。失败返回 error(调用方回退直接 POST)。 */
export async function uploadPoForParse(file: File): Promise<PoUploadResult> {
  if (file.size > PO_PARSE_STORAGE_MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { ok: false, error: `「${file.name}」${mb}MB 超过 10MB 上限,请压缩或截图后重传。` };
  }
  try {
    const supabase = createClient();
    // 文件名进路径前必须消毒:中文/空格/括号会让部分存储网关拒收,只保留扩展名
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `${PO_PARSE_STORAGE_PREFIX}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage
      .from(PO_PARSE_STORAGE_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, path };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
