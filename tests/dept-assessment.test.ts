import { describe, it, expect } from 'vitest';
import { isOnTime, computeDeptScore, DEPT_ROLES } from '@/lib/domain/deptAssessment';

// 部门执行考核(2026-07-25 CEO B 方案):采购/生产中心动作 → 准时考核 → 部门分卡。
describe('isOnTime 准时判定', () => {
  it('实际日 ≤ 目标日 = 准时(目标日当天也算)', () => {
    expect(isOnTime('2026-07-20', '2026-07-18')).toBe(true);
    expect(isOnTime('2026-07-20', '2026-07-20')).toBe(true);   // 当天
  });
  it('实际日晚于目标日 = 逾期', () => {
    expect(isOnTime('2026-07-20', '2026-07-21')).toBe(false);
  });
  it('缺目标日 → null(不计入准时率)', () => {
    expect(isOnTime(null, '2026-07-20')).toBeNull();
    expect(isOnTime(undefined, '2026-07-20')).toBeNull();
  });
});

describe('computeDeptScore 部门分', () => {
  it('全准时 → 100', () => {
    expect(computeDeptScore([{ on_time: true }, { on_time: true }]).score).toBe(100);
  });
  it('半准时 → 50', () => {
    const r = computeDeptScore([{ on_time: true }, { on_time: false }]);
    expect(r.score).toBe(50); expect(r.onTime).toBe(1); expect(r.late).toBe(1);
  });
  it('全逾期 → 0', () => {
    expect(computeDeptScore([{ on_time: false }, { on_time: false }]).score).toBe(0);
  });
  it('无可判定任务(都 null / 空)→ 满分 100,不冤枉', () => {
    expect(computeDeptScore([{ on_time: null }]).score).toBe(100);
    expect(computeDeptScore([]).score).toBe(100);
  });
  it('null 任务不计入分母', () => {
    const r = computeDeptScore([{ on_time: true }, { on_time: null }, { on_time: false }]);
    expect(r.assessed).toBe(2); expect(r.score).toBe(50);
  });
});

describe('DEPT_ROLES', () => {
  it('生产部含 QC(名册:生产部有跟单和QC)', () => {
    expect(DEPT_ROLES.production).toContain('qc');
    expect(DEPT_ROLES.production).toContain('production_manager');
    expect(DEPT_ROLES.procurement).toContain('procurement');
  });
});
