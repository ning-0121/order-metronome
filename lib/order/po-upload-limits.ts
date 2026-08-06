/**
 * PO 识别的文件大小上限 —— 由 **Vercel 平台**决定,不是我们能配的。
 *
 * 【2026-08-05 事故】CEO 传一份 PDF 建单,一直报
 * `An unexpected response was received from the server.`,硬刷新也没用。
 *
 * 真因:**Vercel 对函数请求体的硬上限是 4.5MB**,超了平台直接返 413
 * `FUNCTION_PAYLOAD_TOO_LARGE`,**请求根本到不了我们的函数**。
 * 实测生产:1/3/4MB 都能到应用(405),5MB 和 8MB 一律 413。
 *
 * 而我们三层写的全是 10MB —— next.config 的 serverActions.bodySizeLimit、
 * po-parser 的 MAX_FILE_SIZE_BYTES,UI 上甚至写着「≤ 20MB」。
 * 全都不作数。后果不只是"传不上",而是应用里那句写好的友好提示
 * 「文件 X MB 超出上限,请压缩后重传」**永远没机会执行** ——
 * 用户撞到的是 Next.js 的英文传输错误,完全看不出跟文件大小有关。
 *
 * 所以这道闸必须放在**浏览器端、调 Server Action 之前**。服务端那道留着当兜底,
 * 但它这辈子都等不到大文件。
 *
 * 留 0.5MB 余量:FormData 的分隔符/文件名/其他字段也算进请求体。
 */
export const PO_PARSE_MAX_BYTES = 4 * 1024 * 1024;

/** 超限时给的人话 —— 必须说清"怎么办",不然用户只会反复换文件重传 */
export function poFileTooLargeMessage(file: { name: string; size: number }): string {
  const mb = (file.size / 1024 / 1024).toFixed(1);
  return `「${file.name}」${mb}MB,超过 AI 识别的 ${PO_PARSE_MAX_BYTES / 1024 / 1024}MB 上限`
    + `(服务器平台限制,不是文件本身有问题)。三个办法任选:`
    + `① 把 PDF 压缩一下重传;② 只截图 PO 里有款号/颜色/尺码数量的那部分传上来`
    + `(图片走 vision,比 PDF 更准);③ 直接手工填写,不影响建单。`;
}

/** 超限返回提示语,没超返回 null */
export function checkPoFileSize(file: { name: string; size: number }): string | null {
  return file.size > PO_PARSE_MAX_BYTES ? poFileTooLargeMessage(file) : null;
}
