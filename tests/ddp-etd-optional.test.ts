/**
 * DDP 的 ETD/ETA 选填 —— 锁住「表单与写入层同口径」。
 *
 * 2026-08-06 事故:CEO 2026-07-30 拍板 DDP 的 ETD/ETA 改选填,表单当天改了
 * (提示"船期定了再填,留空按出厂日期排期"),但 ordersRepo 的老硬校验没删 ——
 * 表单说可以空,写入层回「DDP订单必须填写ETD」,业务夹在中间建不了单。
 *
 * 教训:规则改动必须表单 + 写入层一起改。这条测试静态锁写入层:
 * 老校验字符串不许回潮;出厂日期(真正的排期锚点)必须仍被要求。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = readFileSync(resolve(__dirname, '../lib/repositories/ordersRepo.ts'), 'utf-8');

describe('DDP ETD/ETA 选填(写入层)', () => {
  it('insert 路径:不许再硬要 ETD/ETA', () => {
    expect(repo).not.toContain("error: 'DDP订单必须填写ETD'");
    expect(repo).not.toContain('DDP订单必须填写ETA');
  });

  it('update 路径:不许再硬要 ETA(老文案是英文的)', () => {
    expect(repo).not.toContain('Warehouse Due Date is required for DDP orders');
  });

  it('出厂日期仍是必填 —— 它才是排期锚点,豁免不能把锚也豁没了', () => {
    expect(repo).toContain('必须填写出厂日期');
  });

  it('表单侧的选填口径还在(防有人把表单改回必填,又变单边真相)', () => {
    const form = readFileSync(resolve(__dirname, '../components/order/LegacyOrderForm.tsx'), 'utf-8');
    // ETD input 不许带 required
    const m = form.match(/<input type="date" name="etd"[^/]*?\/>/s);
    expect(m).toBeTruthy();
    expect(m![0]).not.toContain('required');
  });
});
