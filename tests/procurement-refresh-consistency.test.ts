/**
 * MRP → 采购项 一致性(2026-08-18,1022977 实证)。
 *
 * 事故形态:
 *   08-11 采购项建成 11616/6336(数量语义 hotfix 之前的算法)
 *   08-12 hotfix 上线
 *   08-14 重新提交 BOM → material_requirements 重算成 5808/3168 ✅
 *         但 advanceProcurementAfterBomSubmit 对非 Pilot 单第一步就 return NOT_PILOT
 *         → 归并没跑 → 采购界面继续消费 2× 的旧事实
 *
 * 切分原则:refresh=数据一致性(全量) / create=新采购意图(Pilot 限定)。
 */
import { describe, it, expect } from 'vitest';
import { decideProcurementAdvance } from '@/lib/procurement/advance';

describe('Pilot 闸的语义边界', () => {
  it('非 Pilot 仍标记为 NOT_PILOT,但**照样归并**(2026-08-18 CEO)', () => {
    const d = decideProcurementAdvance({ isPilot: false, bom: [], requirementCount: 0 });
    expect(d.kind).toBe('NOT_PILOT');
    // 归并不是"新逻辑":采购手动点「归并」调的是同一个 consolidate、同一套参数,
    // 产出逐字段相同。把它闸住只是把隐藏人工门留给了全部非 Pilot 单。
    expect(d.shouldConsolidate).toBe(true);
    expect(d.nextActor).toBe('procurement');
  });

  it('Pilot 独占的是口径就绪门禁,不是归并本身', () => {
    // 非 Pilot:basis 全空也照样归并(沿用历史 PER_SET 兜底,不卡住全公司)
    const nonPilot = decideProcurementAdvance({
      isPilot: false, bom: [{ materialName: '吊卡', consumptionBasis: null }], requirementCount: 5,
    });
    expect(nonPilot.shouldConsolidate).toBe(true);
    // Pilot:basis 未确认 → 不归并,且点名缺哪些物料
    const pilot = decideProcurementAdvance({
      isPilot: true, bom: [{ materialName: '吊卡', consumptionBasis: null }], requirementCount: 5,
    });
    expect(pilot.shouldConsolidate).toBe(false);
    expect(pilot.missingBasisMaterials).toContain('吊卡');
  });

  it('NOT_PILOT 的 message 必须说真话:不能说「流程保持原样」', () => {
    const d = decideProcurementAdvance({ isPilot: false, bom: [], requirementCount: 0 });
    expect(d.message).not.toContain('保持原样');
    expect(d.message).toContain('待采购');
  });
});

describe('needs_reconfirm 判据:总需变了且人已拍过板', () => {
  // 复刻 consolidate 里的判据(app/actions/procurement-items.ts)
  const shouldFlag = (o: { totalChanged: boolean; status: string; final: number | null }) =>
    o.totalChanged && (o.status !== 'draft' || o.final != null);

  it('草稿 + 已填最终量 + 总需变 → 必须提示重新确认(旧口径会漏)', () => {
    expect(shouldFlag({ totalChanged: true, status: 'draft', final: 11965 })).toBe(true);
  });

  it('草稿 + 没填最终量 → 不打扰(还没人做过判断)', () => {
    expect(shouldFlag({ totalChanged: true, status: 'draft', final: null })).toBe(false);
  });

  it('非草稿 + 总需变 → 照旧提示', () => {
    expect(shouldFlag({ totalChanged: true, status: 'confirmed', final: null })).toBe(true);
  });

  it('总需没变 → 任何状态都不打扰', () => {
    expect(shouldFlag({ totalChanged: false, status: 'confirmed', final: 999 })).toBe(false);
    expect(shouldFlag({ totalChanged: false, status: 'draft', final: 999 })).toBe(false);
  });

  it('1022977 实况:draft + final=11965 + 总需 11616→5808 → 会被标记', () => {
    expect(shouldFlag({ totalChanged: 11616 !== 5808, status: 'draft', final: 11965 })).toBe(true);
  });
});
