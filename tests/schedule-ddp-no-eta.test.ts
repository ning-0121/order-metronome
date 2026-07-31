import { describe, it, expect } from 'vitest';
import { calcDueDates, DDP_TRANSIT_DAYS } from '@/lib/schedule';

/**
 * DDP 单没填 ETA 时的排期兜底(2026-07-30 用户:「只要出厂日期」)。
 *
 * 建单改为只强制出厂日期、ETD/ETA 选填。原来 calcDueDates 对非 FOB 只认 eta||warehouse_due_date,
 * 两者都空就直接 throw「缺少锚点日期」→ 整单排不出期。现在兜底用出厂日。
 *
 * 最容易出错的地方:DDP 正常路径会把锚点(ETA)**减 25 天海运**得到出运截止日。
 * 而出厂日本身就是"货离厂"那天,再减一次 → 全部节点提前 25 天。本测试锁死这一点。
 */
const base = { createdAt: new Date('2026-06-01T00:00:00+08:00'), orderDate: '2026-06-01' };

describe('DDP 无 ETA:用出厂日兜底排期', () => {
  it('ETA/送仓日都为空时不再抛错,能正常排出期', () => {
    expect(() => calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null, eta: null,
      factoryDate: '2026-10-01',
    })).not.toThrow();
  });

  it('出厂日兜底时【不减 25 天海运】—— 与用 ETA 时的锚点差正好是 25 天', () => {
    // A: 用 ETA=10/26 → 锚点 = 10/26 − 25 = 10/01
    const viaEta = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: '2026-10-26', factoryDate: null,
    });
    // B: 无 ETA,出厂日=10/01 → 锚点应也是 10/01(不再减)
    const viaFactory = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: null, factoryDate: '2026-10-01',
    });
    // 取同一个节点比对:两者锚点相同 ⇒ 该节点日期应一致
    const keys = Object.keys(viaEta).filter((k) => (viaEta as any)[k] instanceof Date);
    expect(keys.length).toBeGreaterThan(40);   // 全模板节点都要比,别只比到一两个
    for (const k of keys) {
      expect(((viaFactory as any)[k] as Date)?.toISOString(),
        `节点 ${k} 在"ETA 减海运"与"出厂日兜底"两条路下应落在同一天`)
        .toBe(((viaEta as any)[k] as Date)?.toISOString());
    }
  });

  it('若错误地对出厂日也减 25 天,节点会整体提前 —— 反向确认没发生', () => {
    const viaFactory = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: null, factoryDate: '2026-10-01',
    });
    // 拿"把出厂日当 ETA 传"的结果对比:那条路会把锚点再减 25 天 → 排期整体前移。
    // 注意排期是把 T0→锚点 之间**按比例缩放**的,不是刚性平移,所以只断言"更早"而非固定 25 天。
    const wrong = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: '2026-10-01', factoryDate: null,
    });
    const keys = Object.keys(viaFactory).filter((x) => (viaFactory as any)[x] instanceof Date);
    const shifted = keys.filter(
      (k) => ((viaFactory as any)[k] as Date).getTime() > ((wrong as any)[k] as Date).getTime(),
    );
    expect(shifted.length, '兜底路径应明显晚于"把出厂日当ETA"的错误路径').toBeGreaterThan(keys.length / 2);
  });

  it('有 ETA 时仍走原逻辑(减海运),兜底不影响既有单', () => {
    const withEta = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: '2026-10-26', factoryDate: '2026-09-01',   // 出厂日在场也不该抢锚点
    });
    const etaOnly = calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null,
      eta: '2026-10-26', factoryDate: null,
    });
    const k = Object.keys(withEta).find((x) => (withEta as any)[x] instanceof Date)!;
    expect(((withEta as any)[k] as Date).toISOString()).toBe(((etaOnly as any)[k] as Date).toISOString());
  });

  it('FOB 没 ETD 时也用出厂日兜底(原来靠调用方把 factory_date 塞进 etd)', () => {
    const a = calcDueDates({ ...base, incoterm: 'FOB', etd: null, factoryDate: '2026-10-01' });
    const b = calcDueDates({ ...base, incoterm: 'FOB', etd: '2026-10-01' });
    const k = Object.keys(a).find((x) => (a as any)[x] instanceof Date)!;
    expect(((a as any)[k] as Date).toISOString()).toBe(((b as any)[k] as Date).toISOString());
  });

  it('出厂日也没有 → 仍然明确报错,不静默排出错期', () => {
    expect(() => calcDueDates({
      ...base, incoterm: 'DDP', etd: null, warehouseDueDate: null, eta: null, factoryDate: null,
    })).toThrow(/锚点|出厂日期/);
  });
});
