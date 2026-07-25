import { describe, it, expect } from 'vitest';
import { isMissingColumnError, pickMissingColumn } from '@/lib/utils/pg-error';

const COLS = ['product_name_en', 'carton_count', 'created_by', 'po_unit_price', 'purchase_unit_cost', 'fabrics'];

describe('isMissingColumnError', () => {
  it('识别 PostgREST schema cache 报错', () => {
    expect(isMissingColumnError("Could not find the 'x' column of 'y' in the schema cache")).toBe(true);
  });
  it('识别原生 PG does not exist', () => {
    expect(isMissingColumnError('column "x" of relation "y" does not exist')).toBe(true);
  });
  it('非缺列错误(非空约束)不误判', () => {
    expect(isMissingColumnError('null value in column "qty_pcs" violates not-null constraint')).toBe(false);
  });
  it('空输入不炸', () => {
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
  });
});

describe('pickMissingColumn', () => {
  it('PostgREST 格式抠出正确列', () => {
    expect(pickMissingColumn("Could not find the 'purchase_unit_cost' column of 'order_line_items' in the schema cache", COLS))
      .toBe('purchase_unit_cost');
  });
  it('原生 PG 格式抠出正确列', () => {
    expect(pickMissingColumn('column "purchase_unit_cost" of relation "order_line_items" does not exist', COLS))
      .toBe('purchase_unit_cost');
  });
  it('关键回归:purchase_unit_cost 缺失时不牵连 fabrics', () => {
    const col = pickMissingColumn("Could not find the 'purchase_unit_cost' column of 'order_line_items' in the schema cache", COLS, []);
    expect(col).toBe('purchase_unit_cost');
    expect(col).not.toBe('fabrics');
  });
  it('已剔过的列不重复返回(防死循环)', () => {
    expect(pickMissingColumn('column "fabrics" does not exist', COLS, ['fabrics'])).toBeNull();
  });
  it('报错里的列不在候选可选列 → 退回扫描,扫不到返回 null', () => {
    expect(pickMissingColumn('column "some_core_col" does not exist', COLS)).toBeNull();
  });
  it('表名在引号里但列名也在 → 优先抠到列(fabrics)', () => {
    expect(pickMissingColumn("Could not find the 'fabrics' column of 'order_line_items' in the schema cache", COLS))
      .toBe('fabrics');
  });
});
