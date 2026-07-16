import type { POParsedData, POStyleData } from '@/app/actions/po-parser';

type UnknownRecord = Record<string, unknown>;

export interface RecognitionMetadata {
  checksumSha256?: string;
  provider?: string;
  model?: string;
  recognizedAt?: string;
  sourceFileName?: string;
  schemaVersion?: string;
}

export type CompatiblePOParsedData = POParsedData & { _recognition?: RecognitionMetadata };

const obj = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
const text = (...values: unknown[]) => String(values.find((v) => typeof v === 'string' && v.trim()) ?? '').trim();
const num = (...values: unknown[]) => {
  const value = values.find((v) => v !== '' && v != null && Number.isFinite(Number(v)));
  return value == null ? 0 : Number(value);
};
const array = (value: unknown) => Array.isArray(value) ? value : [];

function normalizeSizes(value: unknown): Record<string, number> {
  if (Array.isArray(value)) return Object.fromEntries(value.map((item) => {
    const row = obj(item); return [text(row.label, row.size, row.size_label), num(row.qty, row.quantity, row.value)];
  }).filter(([key]) => key));
  return Object.fromEntries(Object.entries(obj(value)).map(([key, value]) => [key, num(value)]));
}

function normalizeMeasurements(value: unknown): POStyleData['measurements'] {
  return array(value).map((item) => {
    const row = obj(item);
    const rawValues = row.values ?? row.sizes ?? row.measurements;
    const values = Array.isArray(rawValues)
      ? Object.fromEntries(rawValues.map((v) => { const x = obj(v); return [text(x.size, x.label), text(x.value, x.measurement)]; }).filter(([key]) => key))
      : Object.fromEntries(Object.entries(obj(rawValues)).map(([key, v]) => [key, String(v ?? '')]));
    return { label: text(row.label, row.position, row.measurement_point), values };
  }).filter((row) => row.label);
}

/**
 * Reads both the Claude-era object aliases and the strict Runtime V1 shape.
 * Provider-specific formats stop here; all UI/business mapping consumes this canonical shape.
 */
export function normalizePORecognition(raw: unknown): CompatiblePOParsedData {
  const root = obj(raw);
  const rawStyles = array(root.styles ?? root.style_items ?? root.items ?? root.products);
  const styles: POStyleData[] = rawStyles.map((item) => {
    const style = obj(item);
    const colors = array(style.colors ?? style.colorways ?? style.variants).map((itemColor) => {
      const color = obj(itemColor);
      const sizes = normalizeSizes(color.sizes ?? color.size_breakdown ?? color.size_qty);
      return {
        color_cn: text(color.color_cn, color.color_zh, color.color_name_cn),
        color_en: text(color.color_en, color.color, color.colour, color.color_name),
        qty: num(color.qty, color.quantity, Object.values(sizes).reduce((sum, v) => sum + v, 0)),
        sizes,
        packaging: text(color.packaging, color.packing, color.packaging_requirement),
      };
    });
    return {
      style_no: text(style.style_no, style.style_number, style.style, style.sku),
      product_name: text(style.product_name, style.description, style.item_name, style.name),
      material: text(style.material, style.fabric_composition, style.composition, style.fabric),
      fabric_weight: text(style.fabric_weight, style.weight, style.gsm),
      total_qty: num(style.total_qty, style.quantity, style.qty, colors.reduce((sum, c) => sum + c.qty, 0)),
      colors,
      packaging: text(style.packaging, style.packing, style.packaging_requirement),
      quality_notes: text(style.quality_notes, style.quality_requirements, style.quality),
      sample_requirements: text(style.sample_requirements, style.sample_requirement, style.sample_notes),
      unit_consumption: text(style.unit_consumption, style.consumption, style.fabric_consumption),
      measurements: normalizeMeasurements(style.measurements ?? style.size_chart ?? style.measurement_chart),
    };
  });
  const rawTrims = array(root.trims ?? root.accessories ?? root.trim_list);
  return {
    order_no: text(root.order_no, root.po_number, root.customer_po_number, root.po_no),
    customer_name: text(root.customer_name, root.customer, root.buyer_name, root.buyer),
    delivery_date: text(root.delivery_date, root.ship_date, root.required_delivery_date, root.cancel_date),
    order_date: text(root.order_date, root.po_date, root.date),
    garment_category: (text(root.garment_category, root.product_category, root.category) as POParsedData['garment_category']) || 'other',
    styles,
    trims: rawTrims.map((item) => { const trim = obj(item); return {
      name: text(trim.name, trim.accessory_name, trim.trim_name),
      position: text(trim.position, trim.usage_position, trim.placement),
      notes: text(trim.notes, trim.requirements, trim.remark),
    }; }).filter((trim) => trim.name),
    size_labels: array(root.size_labels ?? root.sizes).map(String),
    confidence_notes: array(root.confidence_notes ?? root.warnings ?? root.low_confidence_fields).map(String),
    warning_notes: text(root.warning_notes, root.special_instructions, root.special_requirements),
    unit_price: num(root.unit_price, root.price, root.po_unit_price),
    currency: text(root.currency, root.currency_code),
    total_amount: num(root.total_amount, root.order_amount, root.amount),
    incoterm: text(root.incoterm, root.trade_terms, root.trade_term),
    payment_terms: text(root.payment_terms, root.payment_term),
    _recognition: obj(root._recognition) as RecognitionMetadata,
  };
}

export function parseRecognitionDate(raw: string): string | null {
  const value = String(raw || '').trim();
  const ymd = value.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  const dmy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

export function recognitionToOrderLines(data: CompatiblePOParsedData, sourceFileName: string) {
  const parseConsumption = (raw: string) => {
    for (const [pattern, unit] of [[/([\d.]+)\s*(?:kg|公斤)/i, 'kg'], [/([\d.]+)\s*米/, '米'], [/([\d.]+)\s*码/, '码'], [/([\d.]+)\s*平方/, '平方']] as const) {
      const match = raw.match(pattern); if (match) return { qty: match[1], unit };
    }
    return { qty: '', unit: 'kg' };
  };
  return data.styles.map((style) => {
    const consumption = parseConsumption(style.unit_consumption || '');
    return {
      style_no: style.style_no, product_name: style.product_name, image_url: '',
      source_po_number: data.order_no || sourceFileName,
      fabric_name: [style.material, style.fabric_weight].filter(Boolean).join(' '),
      fabric_width: '', fabric_consumption: consumption.qty, fabric_unit: consumption.unit,
      colors: style.colors.map((color) => ({ color_cn: color.color_cn, color_en: color.color_en,
        sizes: color.sizes || {}, remark: color.packaging || '' })),
    };
  }).filter((style) => style.style_no || style.colors.length);
}

export function buildRecognitionPrefill(items: Array<{ data: CompatiblePOParsedData; fileName: string }>) {
  const orderNos = [...new Set(items.map((item) => item.data.order_no).filter(Boolean))];
  const styles = items.flatMap((item) => item.data.styles);
  const dates = items.map((item) => parseRecognitionDate(item.data.delivery_date)).filter((d): d is string => Boolean(d)).sort();
  const colors = new Set(styles.flatMap((style) => style.colors.map((color) => (color.color_en || color.color_cn).trim().toLowerCase()).filter(Boolean)));
  return {
    customer_name: items[0]?.data.customer_name || '', customer_po_number: orderNos.join(', '),
    total_quantity: styles.reduce((sum, style) => sum + (Number(style.total_qty) || 0), 0),
    style_count: new Set(styles.map((style) => (style.style_no || style.product_name).trim().toLowerCase()).filter(Boolean)).size,
    color_count: colors.size, delivery_date: dates[0] || '',
    order_date: parseRecognitionDate(items.find((item) => item.data.order_date)?.data.order_date || '') || '',
    incoterm: items.find((item) => item.data.incoterm)?.data.incoterm || '',
    currency: items.find((item) => item.data.currency)?.data.currency || '',
    unit_price: items.find((item) => Number(item.data.unit_price) > 0)?.data.unit_price || 0,
    total_amount: items.find((item) => Number(item.data.total_amount) > 0)?.data.total_amount || 0,
    payment_terms: items.find((item) => item.data.payment_terms)?.data.payment_terms || '',
  };
}
