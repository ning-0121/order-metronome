/**
 * 采购三张表的归属纪律(2026-08-01 全面审计后立)。
 *
 * 采购域有三张表,职能是**分层**而不是重复:
 *   procurement_items       核料/归集层(71 列:算需求、找供应商、报价、财务审批)
 *   procurement_line_items  采购执行层(47 列:实际下单、到货、催货)
 *   procurement_tracking    采购台账  (21 列:最简的「谁、什么料、几号到」)
 *
 * 出事的不是分层本身,是**命名**:
 *   procurement-tracking.ts 里曾有 getProcurementItems / addProcurementItem /
 *   updateProcurementItem / deleteProcurementItem —— 名字指向 procurement_items,
 *   实际操作 procurement_tracking;而 procurement.ts 里有一组**同名**函数,
 *   操作的是 procurement_line_items;po-extract.ts 里还有第三个同名的,写 procurement_sheet_items。
 *   同名不同表,是这三张表在认知上糊成一团、"对账对不上"的直接原因。
 *
 * 这里锁两条:
 *   ① 采购相关 action 文件之间**不许有重名导出**;
 *   ② 台账文件只碰台账表 —— 不许再顺手写进另外两张。
 *
 * 注意:本测试扫的是源码文本,不连数据库,所以在 CI 里也能跑。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf-8') : '');

const PROCUREMENT_ACTION_FILES = [
  'app/actions/procurement.ts',
  'app/actions/procurement-items.ts',
  'app/actions/procurement-tracking.ts',
  'app/actions/supply-chain.ts',
  'app/actions/po-extract.ts',
];

function exportedFunctions(src: string): string[] {
  return [...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
}
function tablesTouched(src: string): string[] {
  return [...new Set([...src.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]))];
}

describe('采购 action 文件之间不许重名导出', () => {
  it('同名函数指向不同的表,是三表混淆的根源', () => {
    const seen = new Map<string, string[]>();
    for (const f of PROCUREMENT_ACTION_FILES) {
      for (const fn of exportedFunctions(read(f))) {
        seen.set(fn, [...(seen.get(fn) ?? []), f]);
      }
    }
    const dupes = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(
      dupes.map(([fn, files]) => `${fn} 同时存在于 ${files.join(' 和 ')}`),
      '采购域出现重名导出 —— 请按它实际操作的表改名(参考 *TrackingRow / *LineItem / *Item)',
    ).toEqual([]);
  });
});

describe('台账文件只碰台账表', () => {
  it('procurement-tracking.ts 不得写另外两张采购表', () => {
    const t = tablesTouched(read('app/actions/procurement-tracking.ts'));
    expect(t).toContain('procurement_tracking');
    expect(t).not.toContain('procurement_items');
    expect(t).not.toContain('procurement_line_items');
  });

  it('supply-chain.ts(执行明细投影)只读执行层', () => {
    const t = tablesTouched(read('app/actions/supply-chain.ts'));
    expect(t).toContain('procurement_line_items');
    expect(t).not.toContain('procurement_tracking');
  });
});

describe('已下线的东西不许悄悄回来', () => {
  it('po-extract.ts 不再写 procurement_sheet_items(0 行的废表)', () => {
    // 查的是真实访问 .from('...'),不是注释里提到这个词 —— 注释里恰好有一句说明为什么删它
    expect(tablesTouched(read('app/actions/po-extract.ts'))).not.toContain('procurement_sheet_items');
  });

  it('报价器整条链已删除', () => {
    for (const p of [
      'app/quoter/page.tsx',
      'app/customer-po/new/page.tsx',
      'app/actions/quoter.ts',
      'components/order/POOrderForm.tsx',
    ]) {
      expect(existsSync(resolve(ROOT, p)), `${p} 不该复活`).toBe(false);
    }
  });
});
