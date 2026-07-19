import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFactoryScheduleTruth,
  pickConfirmedStyleImage,
  summarizeConfirmedColors,
  summarizeProductionOrderCard,
} from '../board-truth.ts';

describe('production board truth helpers', () => {
  it('prefers the first confirmed style image and dedupes colors', () => {
    const lines = [
      { style_no: 'S1', image_url: '', color_cn: '红', color_en: null, qty_pcs: 120 },
      { style_no: 'S1', image_url: 'https://cdn.example.com/style-a.jpg', color_cn: '红', color_en: null, qty_pcs: 120 },
      { style_no: 'S1', image_url: 'https://cdn.example.com/style-b.jpg', color_cn: '蓝', color_en: 'Blue', qty_pcs: 80 },
    ];

    assert.equal(pickConfirmedStyleImage(lines), 'https://cdn.example.com/style-a.jpg');

    const colors = summarizeConfirmedColors(lines);
    assert.equal(colors.count, 2);
    assert.equal(colors.label, '2色');
    assert.deepEqual(colors.colors, ['红', '蓝']);
  });

  it('surfaces missing color data explicitly', () => {
    const colors = summarizeConfirmedColors([{ style_no: 'S1', qty_pcs: 50 }]);
    assert.equal(colors.count, null);
    assert.equal(colors.label, '颜色待补');
  });

  it('summarizes production cards without double multiplying sets', () => {
    const summary = summarizeProductionOrderCard(
      [
        { style_no: 'A', product_name: '上衣', color_cn: '红', qty_pcs: 1200 },
        { style_no: 'B', product_name: '裤子', color_cn: '蓝', qty_pcs: 1200 },
      ],
      2400,
      2,
    );

    assert.equal(summary.pieceCount, 2400);
    assert.equal(summary.styleCount, 2);
    assert.equal(summary.colorCount, 2);
    assert.equal(summary.colorLabel, '2色');
  });

  it('prefers dispatch truth and preserves legacy-only fallbacks', () => {
    const rows = buildFactoryScheduleTruth({
      factories: [
        { id: 'f1', factory_name: '傲狐', factory_code: 'AOHU', monthly_capacity: 1000 },
        { id: 'f2', factory_name: '海鸥', factory_code: 'HAIOU', monthly_capacity: null },
        { id: 'f3', factory_name: '零产能', factory_code: 'ZERO', monthly_capacity: 0 },
      ],
      orders: [
        {
          id: 'o1',
          order_no: 'QM-001',
          internal_order_no: 'IN-001',
          customer_name: '客户A',
          factory_id: 'f1',
          factory_name: '傲狐',
          quantity: 2400,
          factory_date: '2026-07-01',
          etd: null,
          lifecycle_status: 'in_progress',
          style_no: 'S1',
          has_manufacturing_order: true,
        },
        {
          id: 'o2',
          order_no: 'QM-002',
          internal_order_no: 'IN-002',
          customer_name: '客户B',
          factory_id: 'f2',
          factory_name: '海鸥',
          quantity: 500,
          factory_date: '2026-07-10',
          etd: null,
          lifecycle_status: 'in_progress',
          style_no: 'S2',
          has_manufacturing_order: false,
        },
        {
          id: 'o3',
          order_no: 'QM-003',
          internal_order_no: 'IN-003',
          customer_name: '客户C',
          factory_id: 'f3',
          factory_name: '零产能',
          quantity: 100,
          factory_date: '2026-07-12',
          etd: null,
          lifecycle_status: 'in_progress',
          style_no: 'S3',
          has_manufacturing_order: false,
        },
      ],
      dispatches: [
        {
          id: 'd1',
          order_id: 'o1',
          style_no: 'S1',
          color: '红',
          factory_id: 'f1',
          factory_name: '傲狐',
          planned_qty: 2400,
          planned_start: '2026-07-01',
          planned_end: '2026-07-03',
          status: 'scheduled',
        },
      ],
    });

    const factory1 = rows.find((row) => row.id === 'f1');
    const factory2 = rows.find((row) => row.id === 'f2');
    const factory3 = rows.find((row) => row.id === 'f3');

    assert.ok(factory1);
    assert.equal(factory1?.source_label, '新排产真值');
    assert.equal(factory1?.active_count, 1);
    assert.equal(factory1?.total_committed, 2400);
    assert.equal(factory1?.capacity_label, '正常');

    assert.ok(factory2);
    assert.equal(factory2?.source_label, 'legacy factory assignment');
    assert.equal(factory2?.active_count, 1);
    assert.equal(factory2?.total_committed, 500);
    assert.equal(factory2?.capacity_label, '月产能未配置');

    assert.ok(factory3);
    assert.equal(factory3?.source_label, 'legacy factory assignment');
    assert.equal(factory3?.capacity_label, '配置产能为0');
  });
});
