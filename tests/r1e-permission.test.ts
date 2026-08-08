/**
 * R1-E Permission Gate —— 注错/投影/角色口径。
 * (B 模式主干路径的 allowed/forbidden/实写已由 R1-C 生产 smoke 证过;这里补齐单元层)
 */
import { describe, it, expect } from 'vitest';
import { canonicalRoles, hasRoleInGroup, ROLE_GROUPS } from '@/lib/domain/roles';

describe('canonicalRoles:双真相收口', () => {
  it('roles[] 非空为准(多角色用户)', () => {
    expect(canonicalRoles({ role: 'sales', roles: ['finance', 'admin'] })).toEqual(['finance', 'admin']);
  });
  it('roles[] 空回退单列(存量旧用户)', () => {
    expect(canonicalRoles({ role: 'qc', roles: [] })).toEqual(['qc']);
    expect(canonicalRoles({ role: 'qc', roles: null })).toEqual(['qc']);
  });
  it('空档案 → 零角色(禁止默认放行)', () => {
    expect(canonicalRoles(null)).toEqual([]);
    expect(canonicalRoles({})).toEqual([]);
  });
});

describe('权限组判定(B 模式的 server 端依据)', () => {
  it('允许角色 → true;不允许 → false;空 → false', () => {
    expect(hasRoleInGroup(['sales_manager'], 'CAN_APPROVE_PRICE')).toBe(true);
    expect(hasRoleInGroup(['production'], 'CAN_APPROVE_PRICE')).toBe(false);
    expect(hasRoleInGroup([], 'CAN_APPROVE_PRICE')).toBe(false);
    expect(hasRoleInGroup(null, 'CAN_APPROVE_PRICE')).toBe(false);
  });
  it('采购金额红线组不含 生产/QC/物流/跟单/督办', () => {
    for (const r of ['production', 'qc', 'logistics', 'merchandiser', 'admin_assistant']) {
      expect(hasRoleInGroup([r], 'CAN_SEE_PROCUREMENT_FLOOR')).toBe(false);
    }
  });
});

describe('采购跟踪 server-side 投影(体检 P2-9)', () => {
  it('源码不再 select(*),且无权限分支不含金额列', async () => {
    const src = (await import('node:fs')).readFileSync('app/actions/procurement-tracking.ts', 'utf-8');
    const fn = src.slice(src.indexOf('getProcurementTrackingRows'), src.indexOf('getProcurementTrackingRows') + 2200);
    expect(fn).not.toContain(".select('*')");
    expect(fn).toContain('CAN_SEE_PROCUREMENT_FLOOR');
    // SAFE_COLS 里不许出现金额字段
    const safe = fn.match(/SAFE_COLS = '([^']+)'/)?.[1] || '';
    expect(safe).not.toContain('amount');
    expect(safe).not.toContain('offline_paid');
  });
});
