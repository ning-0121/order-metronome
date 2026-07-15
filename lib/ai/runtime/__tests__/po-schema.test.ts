import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validatePOParsedData } from '@/lib/ai/scenes/po-schema';

const valid = {
  order_no: 'PO-1', customer_name: 'Customer', delivery_date: '2026.08.01', order_date: '2026.07.01', garment_category: 'tops',
  styles: [{ style_no: 'S1', product_name: 'Top', material: '', fabric_weight: '', total_qty: 10, colors: [{ color_cn: '黑', color_en: 'BLACK', qty: 10, sizes: [{ label: 'M', qty: 10 }], packaging: '' }], packaging: '', quality_notes: '', sample_requirements: '', unit_consumption: '', measurements: [] }],
  trims: [], size_labels: ['M'], unit_price: 0, currency: 'USD', total_amount: 0, incoterm: '', payment_terms: '', confidence_notes: [], warning_notes: '',
};

describe('PO parser Runtime regression', () => {
  it('preserves the existing PO action data shape', () => assert.equal(validatePOParsedData(valid).styles[0].colors[0].sizes.M, 10));
  it('rejects unsafe partial output before draft persistence', () => assert.throws(() => validatePOParsedData({ ...valid, styles: [{ style_no: 'S1', total_qty: 'ten', colors: [] }] })));
  it('routes both submit-time PO verification actions through Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'app/actions/po-verify.ts'), 'utf8');
    assert.equal(source.includes("from '@anthropic-ai/sdk'"), false);
    assert.equal(source.includes('ANTHROPIC_API_KEY'), false);
    assert.equal(source.includes('qimoAI.generateObject'), true);
    assert.equal(source.includes("'order.po.verify'"), true);
    assert.equal(source.includes('order.po.compare.'), true);
  });
});
