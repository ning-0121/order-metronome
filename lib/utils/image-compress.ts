// 客户端图片压缩(2026-07-11):手机拍的码单/凭证照片动辄 5-10MB,直传存储会被网关 413 拒收
// (返回 HTML 错误页 → storage-js 解析 JSON 失败,报「Unexpected token '<'…not valid JSON」)。
// 上传前在浏览器压到 ≤2200px、JPEG 85%(对账/留痕足够清晰),小图(≤1.5MB)与 PDF 原样放行。
// 解码失败(如少数 HEIC)→ 退回原文件,不阻断上传。

export async function compressImageForUpload(
  f: File
): Promise<{ blob: Blob; ext: string; type: string }> {
  const origExt = (f.name.split('.').pop() || 'jpg').toLowerCase();
  const passthrough = { blob: f as Blob, ext: origExt, type: f.type || 'application/octet-stream' };
  if (!f.type.startsWith('image/') || f.size <= 1.5 * 1024 * 1024) return passthrough;
  try {
    const bmp = await createImageBitmap(f);
    const maxSide = 2200;
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return passthrough;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size === 0) return passthrough;
    // 压完反而更大(已高度压缩的小图放大画布)→ 用原文件
    if (blob.size >= f.size) return passthrough;
    return { blob, ext: 'jpg', type: 'image/jpeg' };
  } catch {
    return passthrough;   // HEIC 等解不了码 → 原样上传
  }
}

/** 把存储网关的 HTML 错误(413 等)翻译成人话;其余原样返回。 */
export function friendlyUploadError(message: string, fileName?: string): string {
  if (/Unexpected token|not valid JSON|413|too large|entity too large/i.test(message || '')) {
    return `${fileName ? `「${fileName}」` : ''}文件过大,服务器拒收。请用手机截图(尺寸更小)后重传,或分多张传。`;
  }
  return message;
}
