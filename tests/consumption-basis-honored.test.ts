/**
 * 口径必须被真正使用(2026-08-17,1022967 事故)。
 *
 * 事故:QM-20260714-005(内部单号 1022967,quantity_unit='三件套')
 *   面料单耗 0.53(每件口径),业务要 0.53×2400=1272kg,系统显示 424kg。
 * 根因两步叠加:
 *   ① BOM 面料 consumption_basis 为 NULL → `basis || 'PER_SET'` 静默兜底;
 *   ② quantity_unit='三件套' → 商业数量 = 物理件数 ÷ 3 = 800。
 *   0.53 × 800 = 424。
 * 更深一层:mrp.ts 当时**硬写死 PER_SET**,`consumption_basis` 填了也没人读,
 *   而快照表 material_package_snapshot_lines 根本没有这一列 —— 口径从未被冻结。
 */
import { describe, it, expect } from 'vitest';
import { computeMaterialRequirement } from '@/lib/services/mrp';

const base = {
  po_quantity: 2400,
  stageAnchors: { factory_date: '2026-10-01' } as any,
  today: '2026-08-17',
};
const fabric = (basis?: string | null) => ({
  material_name: '95%涤5%氨 涤空气层250g', material_type: 'fabric',
  material_code: null, unit: 'kg', qty_per_piece: 0.53, loss_rate: 0,
  consumption_basis: basis ?? null,
});

describe('1022967:三件套单的面料需求', () => {
  it('口径=PER_PIECE(每件)→ 0.53×2400=1272,业务期望值', () => {
    const r = computeMaterialRequirement({ ...base, material: fabric('PER_PIECE'), quantityUnit: '三件套' });
    expect(r.gross_requirement).toBeCloseTo(1272, 6);
  });

  it('口径未确认 → 沿用历史 PER_SET(÷3=800)得 424 —— 事故原值,锁住以证明差异来自口径', () => {
    const r = computeMaterialRequirement({ ...base, material: fabric(null), quantityUnit: '三件套' });
    expect(r.gross_requirement).toBeCloseTo(424, 6);
  });

  it('MRP 必须真的读 consumption_basis(此前硬写死 PER_SET,填了也没用)', () => {
    const perPiece = computeMaterialRequirement({ ...base, material: fabric('PER_PIECE'), quantityUnit: '三件套' });
    const perSet = computeMaterialRequirement({ ...base, material: fabric('PER_SET'), quantityUnit: '三件套' });
    expect(perPiece.gross_requirement).not.toBe(perSet.gross_requirement);
    expect(perPiece.gross_requirement).toBeCloseTo(1272, 6);
    expect(perSet.gross_requirement).toBeCloseTo(424, 6);
  });

  it('explain 里要说清按哪个口径算的(数字必须可审计)', () => {
    const r = computeMaterialRequirement({ ...base, material: fabric('PER_PIECE'), quantityUnit: '三件套' });
    const gross = (r.explain_json?.factors ?? []).find((f: any) => f.code === 'gross');
    expect(String(gross?.label)).toContain('PER_PIECE');
    const r2 = computeMaterialRequirement({ ...base, material: fabric(null), quantityUnit: '三件套' });
    const gross2 = (r2.explain_json?.factors ?? []).find((f: any) => f.code === 'gross');
    expect(String(gross2?.label)).toContain('未确认');
  });
});

describe('单位「套」默认当 2 件 —— 同一缺陷的多数形态', () => {
  it('unit=套 未确认口径 → ÷2;确认 PER_PIECE → 不再被除', () => {
    const nullBasis = computeMaterialRequirement({ ...base, material: fabric(null), quantityUnit: '套' });
    const perPiece = computeMaterialRequirement({ ...base, material: fabric('PER_PIECE'), quantityUnit: '套' });
    expect(nullBasis.gross_requirement).toBeCloseTo(0.53 * 1200, 6);   // 2400÷2
    expect(perPiece.gross_requirement).toBeCloseTo(0.53 * 2400, 6);
  });
});

describe('绝不静默变成 0 需求', () => {
  it('计量类口径(PER_KG 等不在跟单可选项里)按未确认处理 —— 不是"按公斤算"', () => {
    // isBasisConfirmed 只认 PER_SET/PER_PIECE/PER_COMPONENT/PER_ORDER,
    // 所以 PER_KG 走的是「未确认」分支。锁住这个边界,免得以后有人以为填了就生效。
    const r = computeMaterialRequirement({ ...base, material: fabric('PER_KG'), quantityUnit: '件' });
    const asUnconfirmed = computeMaterialRequirement({ ...base, material: fabric(null), quantityUnit: '件' });
    expect(r.gross_requirement).toBe(asUnconfirmed.gross_requirement);
    const gross = (r.explain_json?.factors ?? []).find((f: any) => f.code === 'gross');
    expect(String(gross?.label)).toContain('未确认');
  });

  it('needs_input 时需求量必须是 null,不能是 0(null/pack===0 会让采购以为不用买)', () => {
    const r = computeMaterialRequirement({ ...base, material: { ...fabric('PER_PIECE'), qty_per_piece: null }, quantityUnit: '件' });
    expect(r.status).toBe('needs_input');
    expect(r.gross_requirement).toBeNull();
    expect(r.gross_requirement).not.toBe(0);
    expect(r.net_purchase_qty).toBeNull();
  });

  it('缺单耗仍是 needs_input,文案仍说「缺单耗」', () => {
    const r = computeMaterialRequirement({ ...base, material: { ...fabric('PER_PIECE'), qty_per_piece: null }, quantityUnit: '件' });
    expect(r.status).toBe('needs_input');
    expect(String(r.explain_json?.headline)).toContain('缺单耗');
  });
});
