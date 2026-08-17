/**
 * 上传 MIME 兜底纠正(2026-08-17)
 *
 * 事故:上传 Excel 付款凭证报
 *   「mime type text/plain;charset=UTF-8 is not supported」
 *
 * 根因是两层叠加,只修一层不够:
 *   ① order-docs 桶有**硬 MIME 白名单**(见下方 ORDER_DOCS_ALLOWED_MIME,与 Storage 配置一致)。
 *      浏览器把 .xls/.xlsx 识别成 text/plain 时(无扩展名关联、某些系统 MIME 库缺失、
 *      或文件来自导出工具),白名单必拒 —— 而文件本身完全合法。
 *   ② file.type 还可能带参数(';charset=UTF-8')。即使裸类型在白名单里,
 *      带参数的字符串也未必匹配得上。
 *
 * 所以上传前一律走 resolveUploadMime(),不要把 file.type 直接交给存储。
 *
 * ⚠️ 这里只做「纠正」不做「放行」:扩展名查不到映射时返回裸类型(或 octet-stream),
 *    让桶按自己的白名单拒 —— 不假装某个文件是别的类型去骗过白名单。
 *    真要支持新格式(如 CSV),该去改桶的 allowed_mime_types,不是在这里编 MIME。
 */

/** order-docs 桶当前的 allowed_mime_types(2026-08-17 实读 Storage 配置)。改桶配置时同步这里。 */
export const ORDER_DOCS_ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/jpg',
  'image/png',
] as const;

/** 扩展名 → 权威 MIME。只收白名单内的类型,不编造。 */
const EXT_TO_MIME: Record<string, string> = {
  pdf:  'application/pdf',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
};

/** 剥掉 ';charset=…' 之类的参数,取裸 MIME 并小写。 */
export function bareMime(type?: string | null): string {
  return String(type || '').split(';')[0].trim().toLowerCase();
}

/**
 * 决定上传时该声明的 contentType。
 *
 * @param fileName    原文件名(用来取扩展名)
 * @param browserType 浏览器给的 file.type(可能为空、可能带 charset、可能是错的)
 *
 * 优先级:浏览器类型(裸)若已在白名单 → 用它;否则按扩展名兜底;都不行 → 裸类型或 octet-stream。
 */
export function resolveUploadMime(fileName: string, browserType?: string | null): string {
  const bare = bareMime(browserType);
  if ((ORDER_DOCS_ALLOWED_MIME as readonly string[]).includes(bare)) return bare;

  const ext = String(fileName || '').split('.').pop()?.toLowerCase() || '';
  const mapped = EXT_TO_MIME[ext];
  if (mapped) return mapped;

  return bare || 'application/octet-stream';
}

/** 桶按 MIME 拒收时的人话翻译(英文原文对业务毫无意义)。 */
export function friendlyMimeError(message: string, fileName?: string): string | null {
  if (!/mime type .* is not supported|invalid_mime_type/i.test(message || '')) return null;
  const shown = fileName ? `「${fileName}」` : '该文件';
  return `${shown}的格式不被支持。可上传:PDF、Excel(xls/xlsx)、Word(doc/docx)、图片(jpg/png)。`
       + `如果它本来就是这几种之一,请确认文件名带正确扩展名后重传。`;
}
