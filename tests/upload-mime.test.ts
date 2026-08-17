import { describe, it, expect } from 'vitest';
import {
  resolveUploadMime,
  bareMime,
  friendlyMimeError,
  ORDER_DOCS_ALLOWED_MIME,
} from '@/lib/utils/upload-mime';

/**
 * 上传 MIME 兜底(2026-08-17)。
 *
 * 事故:上传 Excel 付款凭证报「mime type text/plain;charset=UTF-8 is not supported」。
 * order-docs 桶有硬 MIME 白名单,浏览器把 .xlsx 认成 text/plain 时必被拒 —— 文件本身是好的。
 */
describe('上传 MIME 兜底纠正', () => {
  it('⭐ 事故复现:.xlsx 被浏览器认成 text/plain;charset=UTF-8 → 纠正为 xlsx 正牌 MIME', () => {
    const got = resolveUploadMime('付款凭证.xlsx', 'text/plain;charset=UTF-8');
    expect(got).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(ORDER_DOCS_ALLOWED_MIME as readonly string[]).toContain(got);
  });

  it('.xls 同样纠正,且落在桶白名单内', () => {
    const got = resolveUploadMime('回单.xls', 'text/plain;charset=UTF-8');
    expect(got).toBe('application/vnd.ms-excel');
    expect(ORDER_DOCS_ALLOWED_MIME as readonly string[]).toContain(got);
  });

  it('浏览器类型本来就对 → 原样保留(不多事)', () => {
    expect(resolveUploadMime('a.pdf', 'application/pdf')).toBe('application/pdf');
    expect(resolveUploadMime('b.png', 'image/png')).toBe('image/png');
  });

  it('带 charset 参数的合法类型 → 剥掉参数后仍认得', () => {
    expect(resolveUploadMime('a.pdf', 'application/pdf; charset=binary')).toBe('application/pdf');
    expect(bareMime('text/plain;charset=UTF-8')).toBe('text/plain');
    expect(bareMime(null)).toBe('');
  });

  it('file.type 为空(某些系统无 MIME 关联)→ 靠扩展名兜底', () => {
    expect(resolveUploadMime('凭证.pdf', '')).toBe('application/pdf');
    expect(resolveUploadMime('单据.docx', undefined)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('大小写/多点文件名不影响判断', () => {
    expect(resolveUploadMime('2026.08 付款.XLSX', 'text/plain')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(resolveUploadMime('a.b.c.JPG', '')).toBe('image/jpeg');
  });

  it('⭐ 不编造 MIME 骗白名单:不认识的扩展名保持原样,让桶按自己的规矩拒', () => {
    // csv 不在桶白名单里 —— 这里绝不能偷偷映射成 Excel 蒙混过关,
    // 要支持 CSV 应该去改桶的 allowed_mime_types。
    expect(resolveUploadMime('明细.csv', 'text/csv')).toBe('text/csv');
    expect(ORDER_DOCS_ALLOWED_MIME as readonly string[]).not.toContain('text/csv');
    expect(resolveUploadMime('未知文件', '')).toBe('application/octet-stream');
  });

  it('映射表产出的 MIME 必须全部在桶白名单内(防将来改桶配置失配)', () => {
    for (const ext of ['pdf', 'xls', 'xlsx', 'doc', 'docx', 'jpg', 'jpeg', 'png']) {
      const got = resolveUploadMime(`f.${ext}`, 'text/plain');
      expect(ORDER_DOCS_ALLOWED_MIME as readonly string[]).toContain(got);
    }
  });

  it('桶拒收时给人话,不是英文原文', () => {
    const msg = friendlyMimeError('mime type text/plain;charset=UTF-8 is not supported', '付款.csv');
    expect(msg).toContain('付款.csv');
    expect(msg).toContain('Excel');
    expect(friendlyMimeError('some other error')).toBeNull();   // 不相干的错不乱翻译
  });
});
