/**
 * R1-F 三条 suspected 修复的静态锁(防回潮)。
 * S1 财务批准接通闸 / S2 一键出货查闸 / S3 制造单价格投影。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('S1 财务批准出货 = 开 allow_shipment 闸', () => {
  const src = read('app/actions/shipments.ts');
  it('approveShipment 批准分支写 allow_shipment=true', () => {
    const fn = src.slice(src.indexOf('export async function approveShipment'), src.indexOf('export async function executeShipment'));
    expect(fn).toContain('allow_shipment: true');
    expect(fn).toContain("decision === 'approved'");
    expect(fn).toContain('safeMutation');      // 断言写入
    expect(fn).toContain("level: 'A2'");        // 强制审计
  });
});

describe('S2 一键出货必过财务放货闸', () => {
  const src = read('app/actions/confirm-shipped.ts');
  it('非 admin + 含出运节点 → 检查 allow_shipment/payment_hold', () => {
    expect(src).toContain('GATE_STEPS');
    expect(src).toContain('allow_shipment');
    expect(src).toContain('payment_hold');
    expect(src).toContain('财务尚未放货');
  });
});

describe('S3 制造单不泄客户价/采购价', () => {
  const src = read('app/actions/manufacturing-order.ts');
  it('无 CAN_SEE_FINANCIALS 剥 po_unit_price/purchase_unit_cost/po_parse_snapshot', () => {
    expect(src).toContain('CAN_SEE_FINANCIALS');
    expect(src).toContain('po_unit_price');
    expect(src).toContain('purchase_unit_cost');
    expect(src).toMatch(/po_parse_snapshot = null|po_parse_snapshot\s*=\s*null/);
  });
});
