import { describe, it, expect } from 'vitest';

/**
 * 逾期处置的业务规则(2026-08-20 CEO:「我们是来进行订单推进的,不只是停在预警上」)。
 *
 * 立足点:每个处置必须产出「一个新的交期承诺(或明确终止)」+「一条留痕」。
 * 红条只在两级审批都过、且写回 orders 之后才消失 —— 不能靠"点掉"消失。
 * 这组用例把这条规则钉死,防止以后为了让流程顺畅而放宽必填。
 */

type ResolutionType = 'reschedule' | 'expedite' | 'discount' | 'abandon' | 'partial_ship' | 'other';

const NEEDS_NEW_DATE: ResolutionType[] = ['reschedule', 'partial_ship'];
const NEEDS_COST: ResolutionType[] = ['expedite', 'discount'];

/** 与 app/actions/delivery-resolution.ts 的校验同构(纯逻辑抽出来测)。 */
function validate(input: {
  resolutionType: ResolutionType;
  newFactoryDate?: string | null; newEtd?: string | null;
  customerResponse?: string; reason?: string; costAmount?: number | null;
}): string | null {
  if (!input.customerResponse?.trim()) return '请填写客户答复';
  if (!input.reason?.trim()) return '请说明为什么选这个处置';
  if (NEEDS_NEW_DATE.includes(input.resolutionType) && !input.newFactoryDate && !input.newEtd) {
    return '必须给出新的出厂日或 ETD';
  }
  if (NEEDS_COST.includes(input.resolutionType) && !(Number(input.costAmount) > 0)) {
    return '必须填写金额';
  }
  return null;
}

const ok = { customerResponse: '客户同意顺延到 9/30', reason: '面料延误' };

describe('逾期处置 · 必须产出交期承诺或代价', () => {
  it('⭐ 改期不给新交期 → 拒绝(没有新交期就不算处置,红条该继续挂着)', () => {
    expect(validate({ ...ok, resolutionType: 'reschedule' })).toMatch(/新的出厂日|ETD/);
    expect(validate({ ...ok, resolutionType: 'reschedule', newFactoryDate: '2026-09-30' })).toBeNull();
    expect(validate({ ...ok, resolutionType: 'reschedule', newEtd: '2026-10-05' })).toBeNull();
  });

  it('分批出货同样要新交期(余量得有个说法)', () => {
    expect(validate({ ...ok, resolutionType: 'partial_ship' })).toMatch(/新的出厂日|ETD/);
    expect(validate({ ...ok, resolutionType: 'partial_ship', newEtd: '2026-10-10' })).toBeNull();
  });

  it('⭐ 快船/打折不填金额 → 拒绝(代价要落进财务口径)', () => {
    expect(validate({ ...ok, resolutionType: 'expedite' })).toMatch(/金额/);
    expect(validate({ ...ok, resolutionType: 'discount' })).toMatch(/金额/);
    expect(validate({ ...ok, resolutionType: 'expedite', costAmount: 8600 })).toBeNull();
    expect(validate({ ...ok, resolutionType: 'discount', costAmount: 12000 })).toBeNull();
  });

  it('金额为 0 或负数不算填了', () => {
    expect(validate({ ...ok, resolutionType: 'expedite', costAmount: 0 })).toMatch(/金额/);
    expect(validate({ ...ok, resolutionType: 'expedite', costAmount: -1 })).toMatch(/金额/);
  });

  it('弃货/其他:不强制新交期与金额(弃货本身就是终止)', () => {
    expect(validate({ ...ok, resolutionType: 'abandon' })).toBeNull();
    expect(validate({ ...ok, resolutionType: 'other' })).toBeNull();
  });

  it('⭐ 任何处置都必须留痕:客户答复与理由缺一不可', () => {
    for (const t of ['reschedule', 'expedite', 'discount', 'abandon', 'partial_ship', 'other'] as ResolutionType[]) {
      expect(validate({ resolutionType: t, reason: 'x', newFactoryDate: '2026-09-30', costAmount: 1 })).toMatch(/客户答复/);
      expect(validate({ resolutionType: t, customerResponse: 'x', newFactoryDate: '2026-09-30', costAmount: 1 })).toMatch(/为什么/);
    }
  });

  it('六种处置类型齐全,与 DB CHECK 约束一致', () => {
    const DB_ENUM = ['reschedule', 'expedite', 'discount', 'abandon', 'partial_ship', 'other'];
    for (const t of DB_ENUM) expect(validate({ ...ok, resolutionType: t as ResolutionType, newFactoryDate: '2026-09-30', costAmount: 1 })).toBeNull();
    expect(DB_ENUM).toHaveLength(6);
  });
});

describe('逾期处置 · 两级审批状态机', () => {
  type S = 'pending' | 'om_approved' | 'approved' | 'rejected';
  /** 与 action 同构:pending →(订单经理)→ om_approved →(财务)→ approved;任一级可 rejected。 */
  function next(cur: S, actor: 'om' | 'finance', decision: 'approve' | 'reject'): S | 'DENY' {
    if (cur === 'approved' || cur === 'rejected') return 'DENY';
    if (decision === 'reject') return 'rejected';
    if (cur === 'pending') return actor === 'om' ? 'om_approved' : 'DENY';
    return actor === 'finance' ? 'approved' : 'DENY';
  }

  it('必须订单经理先批,财务不能越级', () => {
    expect(next('pending', 'finance', 'approve')).toBe('DENY');
    expect(next('pending', 'om', 'approve')).toBe('om_approved');
  });

  it('订单经理批完轮到财务;订单经理不能自己批第二道', () => {
    expect(next('om_approved', 'om', 'approve')).toBe('DENY');
    expect(next('om_approved', 'finance', 'approve')).toBe('approved');
  });

  it('两级都可驳回', () => {
    expect(next('pending', 'om', 'reject')).toBe('rejected');
    expect(next('om_approved', 'finance', 'reject')).toBe('rejected');
  });

  it('⭐ 终态不可再动(防重放/重复写回订单交期)', () => {
    for (const a of ['om', 'finance'] as const)
      for (const d of ['approve', 'reject'] as const) {
        expect(next('approved', a, d)).toBe('DENY');
        expect(next('rejected', a, d)).toBe('DENY');
      }
  });
});
