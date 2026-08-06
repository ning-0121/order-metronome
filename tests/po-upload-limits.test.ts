/**
 * PO 文件大小闸 —— 锁住「上限不得超过 Vercel 平台的 4.5MB」。
 *
 * 2026-08-05:CEO 传 PDF 建单一直报 `An unexpected response was received from the server.`,
 * 硬刷新无效。真因是 **Vercel 对请求体的硬上限 4.5MB**,超了平台直接 413,
 * 函数根本不执行 —— 于是服务端写好的「文件超出上限」友好提示永远跑不到,
 * 用户撞到的是一句看不懂的英文,完全联想不到是文件太大。
 * 实测生产:1/3/4MB 到应用(405),5MB/8MB 一律 413 FUNCTION_PAYLOAD_TOO_LARGE。
 *
 * 这条测试的意义:防止以后有人"顺手"把上限调大。调大不会报错、build 也过,
 * 但会让这个 bug 原样复活。
 */

import { describe, it, expect } from 'vitest';
import { PO_PARSE_MAX_BYTES, checkPoFileSize, poFileTooLargeMessage } from '@/lib/order/po-upload-limits';

const MB = 1024 * 1024;

describe('PO 文件大小闸', () => {
  it('上限不得超过 Vercel 平台硬限制 —— 超了这道闸就白设', () => {
    expect(PO_PARSE_MAX_BYTES).toBeLessThan(4.5 * MB);
  });

  it('4MB 以内放行', () => {
    expect(checkPoFileSize({ name: 'po.pdf', size: 1 * MB })).toBeNull();
    expect(checkPoFileSize({ name: 'po.pdf', size: PO_PARSE_MAX_BYTES })).toBeNull();
  });

  it('超限拦下', () => {
    expect(checkPoFileSize({ name: 'po.pdf', size: PO_PARSE_MAX_BYTES + 1 })).toBeTruthy();
    expect(checkPoFileSize({ name: 'po.pdf', size: 8 * MB })).toBeTruthy();
  });

  it('提示必须说清「怎么办」,不然用户只会反复换文件重传', () => {
    const msg = poFileTooLargeMessage({ name: 'POPRINT_QIMO.pdf', size: 6 * MB });
    expect(msg).toContain('POPRINT_QIMO.pdf');
    expect(msg).toContain('6.0MB');
    expect(msg).toContain('压缩');     // 办法①
    expect(msg).toContain('截图');     // 办法②
    expect(msg).toContain('手工填写'); // 办法③
    expect(msg).toContain('不是文件本身有问题');  // 别让用户以为是自己的 PO 有毛病
  });
});
