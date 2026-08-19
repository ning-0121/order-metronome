import { describe, it, expect } from 'vitest';
import { shouldCompleteProcurementPlaced } from '@/lib/procurement/placedAutoComplete';

/**
 * 「供应商下单」节点自动完成判据(2026-08-19)。
 *
 * 事故:rag / Lyndi 等经销单,采购在系统里建了大货采购单并下达,但节点永远停在「未开始」。
 * 责任人是 procurement,而采购角色进订单详情会被 isProcurementOnly 改道核料页 ——
 * **没有任何地方能完成这个节点**,业务只能干等。
 *
 * 根因:判据只看 procurement_items(原辅料采购项)。经销单买成品,不建 procurement_items,
 * 大货采购直接物化成 procurement_line_items → items.length===0 → 直接 return false。
 * 实测 1022988:procurement_items 0 行 / procurement_line_items 11 行全已挂 PO。
 */
describe('采购下单节点 · 自动完成判据', () => {
  const line = (line_status: string, po: string | null = 'po-1') =>
    ({ line_status, purchase_order_id: po });

  describe('自产单(有 procurement_items)', () => {
    it('采购项全部已下单 → 完成', () => {
      expect(shouldCompleteProcurementPlaced(
        [{ status: 'ordered' }, { status: 'partially_received' }], null)).toBe(true);
    });

    it('还有 draft 采购项 → 不完成', () => {
      expect(shouldCompleteProcurementPlaced(
        [{ status: 'ordered' }, { status: 'draft' }], null)).toBe(false);
    });

    it('有采购项时不看执行行(自产单口径不变)', () => {
      // 采购项没下完,即使执行行都挂了 PO 也不算完成
      expect(shouldCompleteProcurementPlaced(
        [{ status: 'draft' }], [line('ordered'), line('ordered')])).toBe(false);
    });
  });

  describe('⭐ 经销单(procurement_items 为 0 行)', () => {
    it('事故复现:11 条执行行全部已挂 PO 且 ordered → 应完成(修复前恒 false)', () => {
      const lines = Array.from({ length: 11 }, () => line('ordered'));
      expect(shouldCompleteProcurementPlaced([], lines)).toBe(true);
      expect(shouldCompleteProcurementPlaced(null, lines)).toBe(true);
    });

    it('执行行还停在 pending_order(建了单但没下达)→ 不完成', () => {
      expect(shouldCompleteProcurementPlaced([], [line('pending_order')])).toBe(false);
    });

    it('行已 ordered 但没挂 PO → 不完成(没归到采购单不算下单)', () => {
      expect(shouldCompleteProcurementPlaced([], [line('ordered', null)])).toBe(false);
    });

    it('部分行未下达 → 不完成(不能只下了一半就算完)', () => {
      expect(shouldCompleteProcurementPlaced(
        [], [line('ordered'), line('ordered'), line('pending_order')])).toBe(false);
    });

    it('既无采购项也无执行行 → 不完成(什么都没有不能算下过单)', () => {
      expect(shouldCompleteProcurementPlaced([], [])).toBe(false);
      expect(shouldCompleteProcurementPlaced(null, null)).toBe(false);
      expect(shouldCompleteProcurementPlaced(undefined, undefined)).toBe(false);
    });

    it('已收货/已完结的行也算「已下单及以后」', () => {
      expect(shouldCompleteProcurementPlaced(
        [], [line('partially_received'), line('completed'), line('closed')])).toBe(true);
    });
  });
});
