/**
 * 款级 set_multiplier 必须压过订单级 quantity_unit 串(2026-08-17,1022967 事故真根因)。
 *
 * 引擎 deriveQuantityContext 的优先级原本是:
 *   explicitMultiplier > quantity_unit 串解析 > lineItemMultipliers > 1
 * 而逐款算料的两个调用方(BomTab 显示 / 提交采购 MRP)都只传 quantity_unit,
 * 于是**订单级单位串**决定了每一款的折算倍率:
 *   · 1022222 单位「套」→ ÷2,恰好等于该款件/套=2 → 761kg 一直是对的
 *   · 1022967 单位「三件套」→ ÷3,而两个款的件/套是 2 和 1 → 对谁都不对
 *     0.53 × (2400÷3=800) = 424,业务要 0.53 × 2400 = 1272
 *
 * 修法:逐款算料显式传该款 set_multiplier。
 * 本测试同时锁住「修好 1022967」与「不弄坏 1022222」——后者是 2026-07-20 用户拍过板的数。
 */
import { describe, it, expect } from 'vitest';
import { computeMaterialRequirement } from '@/lib/services/mrp';

const anchors = { factory_date: '2026-10-01' } as any;
const req = (o: { pieces: number; cons: number; unit: string; setMul?: number | null }) =>
  computeMaterialRequirement({
    material: {
      material_name: '面料', material_type: 'fabric', material_code: null,
      unit: 'kg', qty_per_piece: o.cons, loss_rate: 0, consumption_basis: 'PER_SET',
    },
    po_quantity: o.pieces,
    quantityUnit: o.unit,
    componentsPerCommercialUnit: o.setMul ?? null,
    stageAnchors: anchors, today: '2026-08-17',
  }).gross_requirement;

describe('1022967(单位「三件套」,款件/套 2 和 1)', () => {
  it('SP1581-B:2400 件 / 件套=1 → 2400 套 × 0.53 = 1272(CEO 确认值)', () => {
    expect(req({ pieces: 2400, cons: 0.53, unit: '三件套', setMul: 1 })).toBeCloseTo(1272, 6);
  });

  it('SP1770:4800 件 / 件套=2 → 2400 套 × 1.04 = 2496', () => {
    expect(req({ pieces: 4800, cons: 1.04, unit: '三件套', setMul: 2 })).toBeCloseTo(2496, 6);
  });

  it('不传款级倍率 → 退回按「三件套」÷3,复现事故值 424(证明差异来自这一处)', () => {
    expect(req({ pieces: 2400, cons: 0.53, unit: '三件套', setMul: null })).toBeCloseTo(424, 6);
  });
});

describe('1022222(单位「套」,款件/套=2)—— 不许被弄坏', () => {
  // 2026-07-20 用户拍板:2400 套 × 0.317 = 761kg,曾误按每件×2 算成 1522 被明确否掉。
  it('传款级倍率 2 → 仍是 761kg', () => {
    expect(req({ pieces: 4800, cons: 0.317, unit: '套', setMul: 2 })).toBeCloseTo(1521.6 / 2, 6);
  });

  it('款级倍率与单位串一致时,传不传结果相同(改动对这类单零影响)', () => {
    const withMul = req({ pieces: 4800, cons: 0.317, unit: '套', setMul: 2 });
    const withoutMul = req({ pieces: 4800, cons: 0.317, unit: '套', setMul: null });
    expect(withMul).toBe(withoutMul);
  });
});

describe('非套装单零影响', () => {
  it('件/套=1 且单位「件」→ 件数即套数,前后一致', () => {
    expect(req({ pieces: 2208, cons: 1, unit: '件', setMul: 1 })).toBeCloseTo(2208, 6);
    expect(req({ pieces: 2208, cons: 1, unit: '件', setMul: null })).toBeCloseTo(2208, 6);
  });
});
