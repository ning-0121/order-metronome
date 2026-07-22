import type { JSONSchema, SchemaValidator } from '@/lib/ai/runtime';
import type { POParsedData } from '@/app/actions/po-parser';
import { AIRuntimeError } from '@/lib/ai/runtime';

const stringField = { type: 'string' };
const numberField = { type: 'number' };

export const poParsedJsonSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'order_no', 'customer_name', 'delivery_date', 'order_date', 'garment_category',
    'styles', 'trims', 'size_labels', 'unit_price', 'currency', 'total_amount',
    'incoterm', 'payment_terms', 'confidence_notes', 'warning_notes',
  ],
  properties: {
    order_no: stringField,
    customer_name: stringField,
    delivery_date: stringField,
    order_date: stringField,
    garment_category: { type: 'string', enum: ['pants', 'tops', 'dress', 'outerwear', 'other'] },
    styles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['style_no', 'product_name', 'material', 'fabric_weight', 'total_qty', 'colors', 'packaging', 'quality_notes', 'sample_requirements', 'unit_consumption', 'measurements'],
        properties: {
          style_no: stringField, product_name: stringField, material: stringField,
          fabric_weight: stringField, total_qty: numberField, packaging: stringField,
          quality_notes: stringField, sample_requirements: stringField, unit_consumption: stringField,
          colors: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              required: ['color_cn', 'color_en', 'qty', 'sizes', 'packaging'],
              properties: {
                color_cn: stringField, color_en: stringField, qty: numberField,
                sizes: {
                  type: 'array', items: {
                    type: 'object', additionalProperties: false, required: ['label', 'qty'],
                    properties: { label: stringField, qty: numberField },
                  },
                },
                packaging: stringField,
              },
            },
          },
          measurements: {
            type: 'array', items: {
              type: 'object', additionalProperties: false, required: ['label', 'values'],
              properties: {
                label: stringField,
                values: {
                  type: 'array', items: {
                    type: 'object', additionalProperties: false, required: ['size', 'value'],
                    properties: { size: stringField, value: stringField },
                  },
                },
              },
            },
          },
        },
      },
    },
    trims: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'position', 'notes'],
        properties: { name: stringField, position: stringField, notes: stringField },
      },
    },
    size_labels: { type: 'array', items: stringField },
    unit_price: numberField,
    currency: stringField,
    total_amount: numberField,
    incoterm: stringField,
    payment_terms: stringField,
    confidence_notes: { type: 'array', items: stringField },
    warning_notes: stringField,
  },
};

// 2026-07-21:改「宽容强制转换」——AI 输出个别字段缺失/类型不符不再整单硬失败(否则复杂PO如RAG
//   把面料成分/克重放表头→AI填不出每款的→null→SCHEMA_MISMATCH→整单"PO识别失败")。
//   缺失降级为空串/0/other/[],产出可编辑草稿("识别结果冻结保存·读错在下方改"),不退回手工从零录。
const str = (v: unknown): string => (v == null ? '' : String(v));
const numOr = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const GARMENT_CATEGORIES = ['pants', 'tops', 'dress', 'outerwear', 'other'];

export function validatePOParsedData(value: unknown): POParsedData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO result must be an object' });
  const data = value as Record<string, unknown>;
  for (const field of ['order_no', 'customer_name', 'delivery_date', 'order_date', 'currency', 'incoterm', 'payment_terms', 'warning_notes']) data[field] = str(data[field]);
  data.unit_price = numOr(data.unit_price);
  data.total_amount = numOr(data.total_amount);
  if (!GARMENT_CATEGORIES.includes(String(data.garment_category))) data.garment_category = 'other';
  data.size_labels = Array.isArray(data.size_labels) ? (data.size_labels as unknown[]).map(str) : [];
  data.confidence_notes = Array.isArray(data.confidence_notes) ? (data.confidence_notes as unknown[]).map(str) : [];
  data.styles = Array.isArray(data.styles) ? data.styles : [];
  data.trims = Array.isArray(data.trims) ? data.trims : [];
  for (const rawStyle of data.styles as unknown[]) {
    if (!rawStyle || typeof rawStyle !== 'object' || Array.isArray(rawStyle)) continue;
    const style = rawStyle as Record<string, unknown>;
    for (const field of ['style_no', 'product_name', 'material', 'fabric_weight', 'packaging', 'quality_notes', 'sample_requirements', 'unit_consumption']) style[field] = str(style[field]);
    style.total_qty = numOr(style.total_qty);
    style.colors = Array.isArray(style.colors) ? style.colors : [];
    for (const rawColor of style.colors as unknown[]) {
      if (!rawColor || typeof rawColor !== 'object' || Array.isArray(rawColor)) continue;
      const row = rawColor as Record<string, unknown>;
      for (const field of ['color_cn', 'color_en', 'packaging']) row[field] = str(row[field]);
      row.qty = numOr(row.qty);
      const sizes: Record<string, number> = {};
      if (Array.isArray(row.sizes)) for (const rawSize of row.sizes as unknown[]) {
        if (!rawSize || typeof rawSize !== 'object' || Array.isArray(rawSize)) continue;
        const size = rawSize as Record<string, unknown>;
        const label = str(size.label); if (label) sizes[label] = numOr(size.qty);
      }
      row.sizes = sizes;
    }
    const measurements = Array.isArray(style.measurements) ? style.measurements : [];
    for (const rawMeasurement of measurements as unknown[]) {
      if (!rawMeasurement || typeof rawMeasurement !== 'object' || Array.isArray(rawMeasurement)) continue;
      const measurement = rawMeasurement as Record<string, unknown>;
      measurement.label = str(measurement.label);
      const values: Record<string, string> = {};
      if (Array.isArray(measurement.values)) for (const rawValue of measurement.values as unknown[]) {
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
        const item = rawValue as Record<string, unknown>;
        const s = str(item.size); if (s) values[s] = str(item.value);
      }
      measurement.values = values;
    }
    style.measurements = measurements;
  }
  for (const rawTrim of data.trims as unknown[]) {
    if (!rawTrim || typeof rawTrim !== 'object' || Array.isArray(rawTrim)) continue;
    const trim = rawTrim as Record<string, unknown>;
    for (const field of ['name', 'position', 'notes']) trim[field] = str(trim[field]);
  }
  return value as POParsedData;
}

export const poParsedSchema: SchemaValidator<POParsedData> = {
  name: 'qimo_po_extraction_v1',
  jsonSchema: poParsedJsonSchema,
  strict: true,
  parse: validatePOParsedData,
};
