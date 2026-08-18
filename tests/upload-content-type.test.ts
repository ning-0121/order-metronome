/**
 * 上传凭证的 contentType 推导(2026-08-18 实发)。
 *
 * 现象:大货采购单传下单凭证 →「上传失败:mime type text/plain;charset=UTF-8 is not supported」
 * 根因:trade-purchase.ts 传 Buffer 给 supabase storage 却**没给 contentType**,
 * supabase-js 默认标成 text/plain;charset=UTF-8,而 order-docs 桶白名单没有它。
 * 全站其它 8 处上传都传了 contentType,只有这一处漏了 —— 所以这个功能从上线起就传不上。
 */
import { describe, it, expect } from 'vitest';

/** 与 app/actions/trade-purchase.ts 内的推导保持一致 */
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const resolveContentType = (fileBase64: string, fileName: string) => {
  const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
  const dataUrlMime = /^data:([^;]+);base64,/.exec(fileBase64)?.[1] || null;
  return dataUrlMime || EXT_MIME[ext] || 'application/octet-stream';
};

describe('contentType 推导', () => {
  it('优先用 data URL 自带的 MIME(浏览器给的最准)', () => {
    expect(resolveContentType('data:image/png;base64,AAAA', 'x.png')).toBe('image/png');
    expect(resolveContentType('data:application/pdf;base64,AAAA', '回单.pdf')).toBe('application/pdf');
  });

  it('data URL 与扩展名冲突时以 data URL 为准', () => {
    // 用户把 png 改名成 .jpg 也不会标错类型
    expect(resolveContentType('data:image/png;base64,AAAA', 'x.jpg')).toBe('image/png');
  });

  it('裸 base64(无 data URL 前缀)→ 按扩展名', () => {
    expect(resolveContentType('AAAA', 'proof.png')).toBe('image/png');
    expect(resolveContentType('AAAA', '下单回单.pdf')).toBe('application/pdf');
    expect(resolveContentType('AAAA', '对账.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('都识别不了 → application/octet-stream,**绝不落回 text/plain**', () => {
    const t = resolveContentType('AAAA', 'weird.xyz');
    expect(t).toBe('application/octet-stream');
    expect(t).not.toContain('text/plain');
  });

  it('无扩展名也不会变成 text/plain', () => {
    expect(resolveContentType('AAAA', 'noext')).toBe('application/octet-stream');
  });
});
