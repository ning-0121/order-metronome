/**
 * R1-F 三条 suspected 修复的静态锁(防回潮)。
 * S1 财务批准接通闸 / S2 一键出货查闸 / S3 制造单价格投影。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('S1 财务批准出货 = 开 allow_shipment 闸(统一放货 Command)', () => {
  it('approveShipment 批准分支走统一 Command approveShipmentRelease(source=internal)', () => {
    const src = read('app/actions/shipments.ts');
    const fn = src.slice(src.indexOf('export async function approveShipment'), src.indexOf('export async function executeShipment'));
    expect(fn).toContain('approveShipmentRelease');
    expect(fn).toContain("source: 'internal'");
    expect(fn).toContain("decision === 'approved'");
  });
  it('统一 Command 开闸 + 写后回读验证 + A2 审计', () => {
    const cmd = read('lib/shipment/approve-release.ts');
    expect(cmd).toContain('allow_shipment: true');
    expect(cmd).toContain('safeCriticalMutation');       // before 快照 + 回读验证
    expect(cmd).toContain("riskLevel: 'money'");          // → A2 审计
    expect(cmd).toContain("verifyFields: { allow_shipment: true }");
  });
  it('外部财务回调也走同一 Command(source=external_finance)', () => {
    const cb = read('app/api/integration/finance-callback/route.ts');
    expect(cb).toContain('approveShipmentRelease');
    expect(cb).toContain("source: 'external_finance'");
  });
});

describe('S2 一键出货必过财务放货闸(硬闸,无 admin 隐式绕过)', () => {
  const src = read('app/actions/confirm-shipped.ts');
  it('财务未放货 → FINANCE_RELEASE_REQUIRED 拒绝', () => {
    expect(src).toContain('allow_shipment');
    expect(src).toContain('payment_hold');
    expect(src).toContain('FINANCE_RELEASE_REQUIRED');
    // 硬闸不再依赖 GATE_STEPS 里是否含出运节点,也不再有 !isAdminActor 隐式绕过
    expect(src).not.toContain('GATE_STEPS');
    expect(src).not.toContain('!isAdminActor');
  });
  it('admin 紧急放行走独立命令(理由必填 + A2 审计)', () => {
    expect(src).toContain('confirmOrderShippedWithOverride');
    expect(src).toContain('shipment_release_override');
    expect(src).toContain('紧急放行必须填写理由');
  });
  it('出货完成后发 shipment.completed 事实事件(≠放货审批)', () => {
    expect(src).toContain('notifyShipmentCompleted');
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
