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
  it('非 Pilot 仍返回 NOT_PILOT(不生成新采购需求)', () => {
    const d = decideProcurementAdvance({ isPilot: false, bom: [], requirementCount: 0 });
    expect(d.kind).toBe('NOT_PILOT');
    expect(d.shouldConsolidate).toBe(false);   // 不 create
  });

  it('NOT_PILOT 的 message 不该暗示「什么都没发生」—— 刷新仍会执行', () => {
    const d = decideProcurementAdvance({ isPilot: false, bom: [], requirementCount: 0 });
    expect(d.message).toContain('未接入');
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
