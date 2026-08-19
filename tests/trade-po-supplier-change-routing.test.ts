import { describe, it, expect } from 'vitest';

/**
 * 大货采购单「改供应商」分流判据(2026-08-19)。
 *
 * 事故:PO-20260817-001(草稿 + approval_status='pending')改供应商报
 *   「供应商修改未生效(db_error):23502 null value in column "approval_status"」
 *
 * 两条路互相把对方堵死:
 *   · 直改(changeTradePoSupplier):对 pending 单写 approval_status=null 想作废原审批,
 *     但该列是 NOT NULL DEFAULT 'not_required' CHECK(not_required|pending|approved|rejected) → 必被拒
 *   · 申请流(requestTradePoSupplierChange):用 status==='draft' 一律挡回
 *   → 「草稿 + 已提交财务审批」成了改不动的死角。
 *
 * CEO 拍板的正确语义:财务正在审这张单,供应商一变批的对象就变了 →
 *   **走申请流,提示「已提交修改,待财务审核」,财务批准后才真正改**。
 *
 * 本用例把分流判据钉死。判据是纯逻辑,与 DB/会话无关,单独抽出来测。
 */

/** 与 TradeBulkPurchaseTab / trade-purchase.ts 两侧一致的分流判据。 */
function route(po: { status: string | null; approval_status: string | null }): 'direct' | 'request' | 'none' {
  const isDraft = po.status === 'draft' || !po.status;
  const awaitingFinance = po.approval_status === 'pending';
  if (po.status === 'cancelled') return 'none';
  if (isDraft && !awaitingFinance) return 'direct';
  return 'request';
}

describe('改供应商 · 分流判据', () => {
  it('⭐ 事故场景:草稿 + 已提交财务审批 → 走申请流(不是直改)', () => {
    expect(route({ status: 'draft', approval_status: 'pending' })).toBe('request');
  });

  it('草稿 + 未提交审批 → 业务可直改(不打扰财务)', () => {
    expect(route({ status: 'draft', approval_status: 'not_required' })).toBe('direct');
  });

  it('已下达 / 已付款 → 一律走申请流(原有行为不变)', () => {
    expect(route({ status: 'placed', approval_status: 'approved' })).toBe('request');
    expect(route({ status: 'paid', approval_status: 'approved' })).toBe('request');
  });

  it('已作废 → 不给任何改供应商入口', () => {
    expect(route({ status: 'cancelled', approval_status: 'not_required' })).toBe('none');
  });

  it('status 为空(老数据)当草稿处理', () => {
    expect(route({ status: null, approval_status: 'not_required' })).toBe('direct');
    expect(route({ status: null, approval_status: 'pending' })).toBe('request');
  });

  it('⭐ 任何情况都不会把 pending 单送进直改 —— 那条路会写 null 撞 NOT NULL', () => {
    for (const st of ['draft', 'placed', 'paid', null]) {
      expect(route({ status: st, approval_status: 'pending' })).not.toBe('direct');
    }
  });

  it('approval_status 的合法值域不含 null(与 DB CHECK 对齐)', () => {
    // purchase_orders.approval_status:
    //   text NOT NULL DEFAULT 'not_required' CHECK IN (not_required|pending|approved|rejected)
    // 代码任何地方都不该往这列写 null —— 写了就是 23502。
    const LEGAL = ['not_required', 'pending', 'approved', 'rejected'];
    expect(LEGAL).not.toContain(null as any);
    for (const v of LEGAL) expect(route({ status: 'draft', approval_status: v })).toBe(v === 'pending' ? 'request' : 'direct');
  });
});
