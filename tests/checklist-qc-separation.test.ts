import { describe, it, expect } from 'vitest';
import { canEditChecklistItemRole } from '@/lib/domain/checklist';

/**
 * QC 与生产部跟单的检查项隔离(2026-07-30)。
 *
 * 背景:原来有个 merchGroup=[merchandiser,production,production_manager,qc,quality]「组内互填」,
 * QC 和跟单可以随便填对方的字段 —— 这是"QC 没真正分离"的根。
 *
 * 但不能简单删:step_key 跨模板语义漂移。生产库实测 final_qc_check 同时存在三种 owner_role
 * (merchandiser 59 / production 89 / qc 1),而 CHECKLIST_MAP 只按 step_key 索引、
 * 字段 role 是全局写死的一个值(历史上全标 merchandiser)。直接按字段 role 收紧会锁死 148/149 张单。
 *
 * 现在的规则:**以该单里程碑物化的 owner_role 为准**,字段 role 退为补充。
 */

// 中查/尾查字段历史上全标 merchandiser(至今未改),用它做入参才贴近真实
const QC_ITEM_ROLE_LEGACY = 'merchandiser';

describe('QC / 跟单 检查项隔离', () => {
  describe('V3 单:mid_qc_check / final_qc_check 归 qc', () => {
    const owner = 'qc';
    it('QC 能填自己的验货节点', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['qc'], owner)).toBe(true);
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['quality'], owner)).toBe(true);
    });
    it('生产部跟单 填不了 QC 的验货节点(这就是"分离")', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['production'], owner)).toBe(false);
    });
    it('生产部经理 也填不了 QC 结论(验货要独立;主管是委派加查,不是自己填)', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['production_manager'], owner)).toBe(false);
    });
  });

  describe('在途 V1 单:final_qc_check 归 production(89 张)', () => {
    const owner = 'production';
    it('生产部跟单 照常能填 —— 不能因为这次改动被锁死', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['production'], owner)).toBe(true);
    });
    it('生产部经理 也能填(监督跟单 + 自己也跟单)', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['production_manager'], owner)).toBe(true);
    });
  });

  describe('在途 V2 单:归 merchandiser(59 张)', () => {
    const owner = 'merchandiser';
    it('跟单照常能填', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['merchandiser'], owner)).toBe(true);
    });
    it('业务(sales)仍与跟单互通(历史一人身兼)', () => {
      expect(canEditChecklistItemRole(QC_ITEM_ROLE_LEGACY, ['sales'], owner)).toBe(true);
    });
  });

  describe('一个节点里嵌别部门字段:仍按字段 role 放行', () => {
    // order_docs_bom_complete:procurement 6 项 + sales 1 项,节点 owner 是 sales 侧
    it('采购能填节点内的 procurement 字段', () => {
      expect(canEditChecklistItemRole('procurement', ['procurement'], 'sales')).toBe(true);
    });
    it('采购填不了同节点的 sales 字段以外的东西 —— 非本人角色且非 owner 则拒', () => {
      expect(canEditChecklistItemRole('finance', ['procurement'], 'sales')).toBe(false);
    });
  });

  describe('兜底', () => {
    it('字段未标角色 → 人人可填', () => {
      expect(canEditChecklistItemRole('', ['production'], 'qc')).toBe(true);
    });
    it('没传 owner_role → 退化为只看字段 role,不误放行', () => {
      expect(canEditChecklistItemRole('qc', ['production'])).toBe(false);
      expect(canEditChecklistItemRole('qc', ['qc'])).toBe(true);
    });
    it('QC 填不了财务字段', () => {
      expect(canEditChecklistItemRole('finance', ['qc'], 'qc')).toBe(false);
    });
  });
});
