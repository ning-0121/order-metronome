import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRecognitionPrefill, normalizePORecognition, recognitionToOrderLines } from '../po-autofill';

describe('PO recognition compatibility and approved-form mapping', () => {
  it('reads Claude-era aliases and object size maps', () => {
    const data = normalizePORecognition({ po_number: 'PO-OLD', customer: 'Old Customer', ship_date: '2026.08.30',
      items: [{ style_number: 'S1', description: 'Top', composition: 'Cotton', quantity: 12,
        colorways: [{ color: 'BLACK', quantity: 12, size_breakdown: { S: 5, M: 7 } }] }], warnings: ['check'] });
    assert.equal(data.order_no, 'PO-OLD'); assert.deepEqual(data.styles[0].colors[0].sizes, { S: 5, M: 7 });
  });
  it('maps recognition into editable order prefill without becoming order truth', () => {
    const data = normalizePORecognition({ order_no: 'PO-1', customer_name: 'Demo', delivery_date: '2026.08.30', order_date: '2026-07-16',
      styles: [{ style_no: 'A', total_qty: 1200, unit_consumption: '0.32kg', colors: [{ color_en: 'BLACK', qty: 1200, sizes: { M: 1200 } }] }],
      incoterm: 'FOB', currency: 'USD', unit_price: 5.25, total_amount: 6300 });
    const prefill = buildRecognitionPrefill([{ data, fileName: 'test.xlsx' }]);
    assert.deepEqual({ customer_po_number: prefill.customer_po_number, total_quantity: prefill.total_quantity, delivery_date: prefill.delivery_date, incoterm: prefill.incoterm },
      { customer_po_number: 'PO-1', total_quantity: 1200, delivery_date: '2026-08-30', incoterm: 'FOB' });
    const line = recognitionToOrderLines(data, 'test.xlsx')[0];
    assert.deepEqual({ style_no: line.style_no, fabric_consumption: line.fabric_consumption, fabric_unit: line.fabric_unit },
      { style_no: 'A', fabric_consumption: '0.32', fabric_unit: 'kg' });
  });
  it('keeps employee values authoritative by exposing suggestions without mutation', () => {
    const approved = { customer_name: 'Employee Corrected' };
    const suggestion = buildRecognitionPrefill([{ data: normalizePORecognition({ customer: 'AI Suggested', styles: [] }), fileName: 'po.csv' }]);
    assert.equal({ ...suggestion, ...approved }.customer_name, 'Employee Corrected');
  });
});
