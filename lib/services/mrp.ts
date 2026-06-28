/**
 * Explainable + 时间分段 MRP —— 纯函数,无 DB,today 入参,可单测(仿 lib/runtime/deliveryConfidence.ts)。
 * 算"买多少 + 最晚什么时候下单 + 为什么"。B1 阶段:库存/余料=0,lead 来源恒为 default。
 */
import { addWorkingDays, subtractWorkingDays } from '@/lib/utils/date';

/** material_type(BOM)→ category(供应链分类) */
export const MATERIAL_TYPE_TO_CATEGORY: Record<string, string> = {
  fabric: 'fabric', lining: 'fabric',
  trim: 'trim', label: 'trim',
  packing: 'packing',
  print: 'print', embroidery: 'embroidery', washing: 'washing', service: 'service',
  other: 'other',
};

/** category → required_stage */
export const CATEGORY_TO_STAGE: Record<string, string> = {
  fabric: 'cutting', print: 'cutting',
  trim: 'sewing', embroidery: 'sewing',
  washing: 'packing', packing: 'packing',
  service: 'other', other: 'other',
};

/** category → 默认供应商交期(工作日,CEO 2026-06-28 拍板) */
export const DEFAULT_LEAD_DAYS: Record<string, number> = {
  fabric: 15, trim: 10, packing: 7, print: 10, embroidery: 10, washing: 7, service: 7, other: 10,
};

const DUE_SOON_WORKDAYS = 3;

export interface StageAnchors {
  cutting?: string | null;   // 'YYYY-MM-DD'
  sewing?: string | null;
  packing?: string | null;
  shipment?: string | null;
  sample?: string | null;
  factory_date?: string | null;
}

export interface MrpMaterialInput {
  material_name: string;
  material_type?: string | null;
  material_code?: string | null;
  unit?: string | null;
  qty_per_piece?: number | null;
  loss_rate?: number | null;   // %
}

export interface MrpInput {
  material: MrpMaterialInput;
  po_quantity: number;
  stageAnchors: StageAnchors;
  inventoryQty?: number;   // v1 = 0
  reuseQty?: number;       // v1 = 0
  today: string;           // 'YYYY-MM-DD'
}

export interface MrpResult {
  category: string;
  required_stage: string;
  material_name: string;
  material_type: string | null;
  material_code: string | null;
  unit: string | null;
  gross_requirement: number | null;
  loss_qty: number | null;
  inventory_deduct: number;
  reuse_deduct: number;
  net_purchase_qty: number | null;
  required_date: string | null;
  supplier_lead_days: number;
  lead_days_source: 'default' | 'manual' | 'quote' | 'supplier_profile';
  order_by_date: string | null;
  timing_status: 'on_time' | 'due_soon' | 'late' | 'unknown';
  status: 'open' | 'fulfilled' | 'needs_input';
  explain_json: any;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function asDate(ymd: string): Date { return new Date(ymd.slice(0, 10) + 'T00:00:00+08:00'); }
function round1(n: number): number { return Math.round(n * 10) / 10; }

export function computeMaterialRequirement(input: MrpInput): MrpResult {
  const { material, po_quantity, stageAnchors } = input;
  const inv = input.inventoryQty ?? 0;
  const reuse = input.reuseQty ?? 0;
  const today = input.today;

  const category = MATERIAL_TYPE_TO_CATEGORY[material.material_type || 'other'] || 'other';
  const required_stage = CATEGORY_TO_STAGE[category] || 'other';
  const supplier_lead_days = DEFAULT_LEAD_DAYS[category] ?? 10;
  const lead_days_source = 'default' as const;

  // required_date:取 stage 锚点(action 已按优先级解析进 stageAnchors),缺则 factory_date 兜底
  const rawAnchor = (stageAnchors as Record<string, string | null | undefined>)[required_stage];
  const required_date = (rawAnchor || stageAnchors.factory_date || null)
    ? String(rawAnchor || stageAnchors.factory_date).slice(0, 10)
    : null;

  // ── 数量 ──
  const consumption = material.qty_per_piece;
  const loss_rate = material.loss_rate ?? 0;
  let gross_requirement: number | null = null;
  let loss_qty: number | null = null;
  let net_purchase_qty: number | null = null;
  let status: MrpResult['status'] = 'open';

  if (consumption == null || !(consumption > 0)) {
    status = 'needs_input';   // 缺单耗
  } else {
    gross_requirement = round1(po_quantity * consumption);
    loss_qty = round1(gross_requirement * (loss_rate / 100));
    const net_raw = gross_requirement + loss_qty - inv - reuse;
    net_purchase_qty = Math.max(0, Math.ceil(net_raw));   // 宁多勿缺,向上取整
    if (net_purchase_qty === 0) status = 'fulfilled';
  }

  // ── 时间 ──
  let order_by_date: string | null = null;
  let timing_status: MrpResult['timing_status'] = 'unknown';
  if (required_date) {
    order_by_date = isoDate(subtractWorkingDays(asDate(required_date), supplier_lead_days));
    const todayD = asDate(today);
    const dueSoonD = addWorkingDays(todayD, DUE_SOON_WORKDAYS);
    const obd = asDate(order_by_date);
    if (obd < todayD) timing_status = 'late';
    else if (obd <= dueSoonD) timing_status = 'due_soon';
    else timing_status = 'on_time';
  }

  // ── explain ──
  const assumptions: string[] = [
    `供应商交期使用默认值 ${supplier_lead_days} 个工作日(来源:default;采购可手填覆盖)`,
  ];
  if (category === 'print') {
    assumptions.push('印花默认按开裁(cutting)阶段处理;若为成衣后印花/特殊后整理,需人工改阶段');
  }
  if (status === 'needs_input') assumptions.push('该物料缺单耗(qty_per_piece),无法计算需求量,请业务补录');
  if (!required_date) assumptions.push('缺该阶段日期,无法定最晚下单日');

  const u = material.unit || '';
  const explain_json = {
    headline: status === 'needs_input'
      ? `${material.material_name}:缺单耗,无法计算采购量`
      : `建议采购 ${material.material_name} ${net_purchase_qty ?? '—'}${u}` +
        (order_by_date ? `,最晚 ${order_by_date} 前下单` : ''),
    factors: gross_requirement != null ? [
      { code: 'gross', label: `PO ${po_quantity} × 单耗 ${consumption}`, value: gross_requirement, unit: u },
      { code: 'loss', label: `损耗 ${loss_rate}%`, value: loss_qty, unit: u },
      { code: 'inventory', label: '扣现有库存(v1=0)', value: -inv, unit: u },
      { code: 'reuse', label: '扣可复用余料(v1=0)', value: -reuse, unit: u },
    ] : [],
    result: { net_purchase_qty, unit: u, required_stage, required_date, order_by_date, timing_status },
    next_action: status === 'needs_input' ? '业务补录单耗' : '采购确认数量并询价',
    assumptions,
    lead_days_source,
    computed_at: today,
  };

  return {
    category, required_stage,
    material_name: material.material_name,
    material_type: material.material_type || null,
    material_code: material.material_code || null,
    unit: material.unit || null,
    gross_requirement, loss_qty,
    inventory_deduct: inv, reuse_deduct: reuse, net_purchase_qty,
    required_date, supplier_lead_days, lead_days_source, order_by_date, timing_status,
    status, explain_json,
  };
}
