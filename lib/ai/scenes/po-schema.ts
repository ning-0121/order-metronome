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

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `${path} must be a string` });
}

function assertNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `${path} must be a finite number` });
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `${path} must be an array` });
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
}

export function validatePOParsedData(value: unknown): POParsedData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO result must be an object' });
  const data = value as Record<string, unknown>;
  for (const field of ['order_no', 'customer_name', 'delivery_date', 'order_date', 'currency', 'incoterm', 'payment_terms', 'warning_notes']) assertString(data[field], field);
  for (const field of ['unit_price', 'total_amount']) assertNumber(data[field], field);
  if (!['pants', 'tops', 'dress', 'outerwear', 'other'].includes(String(data.garment_category))) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'garment_category is invalid' });
  if (!Array.isArray(data.styles) || !Array.isArray(data.trims)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO list fields are invalid' });
  assertStringArray(data.size_labels, 'size_labels');
  assertStringArray(data.confidence_notes, 'confidence_notes');
  for (const [index, rawStyle] of data.styles.entries()) {
    if (!rawStyle || typeof rawStyle !== 'object' || Array.isArray(rawStyle)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}] is invalid` });
    const style = rawStyle as Record<string, unknown>;
    for (const field of ['style_no', 'product_name', 'material', 'fabric_weight', 'packaging', 'quality_notes', 'sample_requirements', 'unit_consumption']) assertString(style[field], `styles[${index}].${field}`);
    if (!Array.isArray(style.colors)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].colors is invalid` });
    assertNumber(style.total_qty, `styles[${index}].total_qty`);
    for (const color of style.colors) {
      if (!color || typeof color !== 'object' || Array.isArray(color)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].colors is invalid` });
      const row = color as Record<string, unknown>;
      for (const field of ['color_cn', 'color_en', 'packaging']) assertString(row[field], `styles[${index}].colors.${field}`);
      assertNumber(row.qty, `styles[${index}].colors.qty`);
      if (!Array.isArray(row.sizes)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].color sizes are invalid` });
      const sizes: Record<string, number> = {};
      for (const [sizeIndex, rawSize] of row.sizes.entries()) {
        if (!rawSize || typeof rawSize !== 'object' || Array.isArray(rawSize)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].colors.sizes[${sizeIndex}] is invalid` });
        const size = rawSize as Record<string, unknown>;
        assertString(size.label, `styles[${index}].colors.sizes[${sizeIndex}].label`);
        if (typeof size.qty !== 'number' || !Number.isFinite(size.qty)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].colors.sizes[${sizeIndex}].qty is invalid` });
        sizes[size.label] = size.qty;
      }
      row.sizes = sizes;
    }
    if (!Array.isArray(style.measurements)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].measurements is invalid` });
    for (const [measurementIndex, rawMeasurement] of style.measurements.entries()) {
      if (!rawMeasurement || typeof rawMeasurement !== 'object' || Array.isArray(rawMeasurement)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].measurements[${measurementIndex}] is invalid` });
      const measurement = rawMeasurement as Record<string, unknown>;
      assertString(measurement.label, `styles[${index}].measurements[${measurementIndex}].label`);
      if (!Array.isArray(measurement.values)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].measurements[${measurementIndex}].values is invalid` });
      const values: Record<string, string> = {};
      for (const [valueIndex, rawValue] of measurement.values.entries()) {
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `styles[${index}].measurements.values[${valueIndex}] is invalid` });
        const item = rawValue as Record<string, unknown>;
        assertString(item.size, `styles[${index}].measurements.values[${valueIndex}].size`);
        assertString(item.value, `styles[${index}].measurements.values[${valueIndex}].value`);
        values[item.size] = item.value;
      }
      measurement.values = values;
    }
  }
  for (const [index, rawTrim] of data.trims.entries()) {
    if (!rawTrim || typeof rawTrim !== 'object' || Array.isArray(rawTrim)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: `trims[${index}] is invalid` });
    const trim = rawTrim as Record<string, unknown>;
    for (const field of ['name', 'position', 'notes']) assertString(trim[field], `trims[${index}].${field}`);
  }
  return value as POParsedData;
}

export const poParsedSchema: SchemaValidator<POParsedData> = {
  name: 'qimo_po_extraction_v1',
  jsonSchema: poParsedJsonSchema,
  strict: true,
  parse: validatePOParsedData,
};
