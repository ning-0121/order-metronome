import { factoryMonthlyLoad, monthlyLedger } from './capacityLedger.ts';

export interface ProductionBoardLineRow {
  style_no?: string | null;
  product_name?: string | null;
  image_url?: string | null;
  color_cn?: string | null;
  color_en?: string | null;
  qty_pcs?: number | null;
}

export interface ProductionBoardCardSummary {
  pieceCount: number | null;
  styleCount: number | null;
  colorCount: number | null;
  colorLabel: string;
}

export interface ProductionBoardFactoryRow {
  id: string;
  factory_name: string;
  factory_code?: string | null;
  cooperation_status?: string | null;
  monthly_capacity: number | null;
  product_categories?: string[] | null;
  quality_grades?: string[] | null;
  weave_types?: string[] | null;
  can_package?: boolean | null;
  order_capabilities?: string[] | null;
  dispatches: Array<FactoryScheduleDispatchRow>;
  total_committed: number;
  active_count: number;
  source_label: string;
  capacity_label: string;
  ledger: Array<{ month: string; committed: number; capacity: number | null; remaining: number | null }>;
}

export interface FactoryScheduleOrderRow {
  id: string;
  order_no: string | null;
  internal_order_no: string | null;
  customer_name: string | null;
  factory_id: string | null;
  factory_name: string | null;
  quantity: number | null;
  factory_date: string | null;
  etd: string | null;
  lifecycle_status: string | null;
  style_no: string | null;
  has_manufacturing_order: boolean;
}

export interface FactoryScheduleDispatchRow {
  id: string;
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;
  customer_name: string | null;
  style_no: string | null;
  color: string | null;
  factory_id: string | null;
  factory_name: string | null;
  planned_qty: number | null;
  planned_start: string | null;
  planned_end: string | null;
  status: string | null;
  source: 'dispatch' | 'legacy';
  order_factory_date: string | null;
}

function normalizeColorKey(line: ProductionBoardLineRow): string {
  return String(line.color_cn || line.color_en || '').trim().toLowerCase();
}

export function pickConfirmedStyleImage(lines: ProductionBoardLineRow[]): string | null {
  for (const line of lines || []) {
    const url = String(line.image_url || '').trim();
    if (url) return url;
  }
  return null;
}

export function summarizeConfirmedColors(lines: ProductionBoardLineRow[]): { colors: string[]; count: number | null; label: string } {
  const colors = [...new Set((lines || []).map(normalizeColorKey).filter(Boolean))];
  if (colors.length === 0) return { colors: [], count: null, label: '颜色待补' };
  return { colors, count: colors.length, label: `${colors.length}色` };
}

export function summarizeProductionOrderCard(
  lines: ProductionBoardLineRow[],
  orderQuantity?: number | null,
  styleCount?: number | null,
): ProductionBoardCardSummary {
  const pieceCount = Number(orderQuantity) > 0
    ? Number(orderQuantity)
    : (lines || []).reduce((sum, line) => sum + (Number(line.qty_pcs) || 0), 0) || null;
  const styleCountResolved = Number(styleCount) > 0
    ? Number(styleCount)
    : [...new Set((lines || []).map((line) => String(line.style_no || '').trim()).filter(Boolean))].length || null;
  const color = summarizeConfirmedColors(lines);
  return {
    pieceCount,
    styleCount: styleCountResolved,
    colorCount: color.count,
    colorLabel: color.label,
  };
}

function toMonthAnchor(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.slice(0, 10);
}

function resolveFactoryKey(
  factoryById: Map<string, FactoryScheduleFactoryLike>,
  factoryByName: Map<string, FactoryScheduleFactoryLike>,
  factoryId?: string | null,
  factoryName?: string | null,
): FactoryScheduleFactoryLike | null {
  const id = String(factoryId || '').trim();
  if (id && factoryById.has(id)) return factoryById.get(id) || null;
  const name = String(factoryName || '').trim().toLowerCase();
  if (name && factoryByName.has(name)) return factoryByName.get(name) || null;
  return null;
}

export interface FactoryScheduleFactoryLike {
  id: string;
  factory_name: string;
  factory_code?: string | null;
  cooperation_status?: string | null;
  monthly_capacity?: number | null;
  product_categories?: string[] | null;
  quality_grades?: string[] | null;
  weave_types?: string[] | null;
  can_package?: boolean | null;
  order_capabilities?: string[] | null;
}

export function buildFactoryScheduleTruth(input: {
  factories: FactoryScheduleFactoryLike[];
  orders: FactoryScheduleOrderRow[];
  dispatches: Array<{
    id: string;
    order_id: string;
    style_no?: string | null;
    color?: string | null;
    factory_id?: string | null;
    factory_name?: string | null;
    planned_qty?: number | null;
    planned_start?: string | null;
    planned_end?: string | null;
    status?: string | null;
  }>;
}): ProductionBoardFactoryRow[] {
  const factoryById = new Map(input.factories.map((factory) => [factory.id, factory]));
  const factoryByName = new Map(input.factories.map((factory) => [factory.factory_name.trim().toLowerCase(), factory]));
  const dispatchesByOrder = new Map<string, typeof input.dispatches>();
  for (const dispatch of input.dispatches || []) {
    const current = dispatchesByOrder.get(dispatch.order_id) || [];
    current.push(dispatch);
    dispatchesByOrder.set(dispatch.order_id, current);
  }

  const rowsByFactory = new Map<string, FactoryScheduleDispatchRow[]>();
  const sourceCounts = new Map<string, { dispatch: number; legacy: number }>();

  for (const order of input.orders || []) {
    const activeDispatches = dispatchesByOrder.get(order.id) || [];
    if (activeDispatches.length > 0) {
      for (const dispatch of activeDispatches) {
        const factory = resolveFactoryKey(factoryById, factoryByName, dispatch.factory_id || order.factory_id, dispatch.factory_name || order.factory_name);
        if (!factory) continue;
        const row: FactoryScheduleDispatchRow = {
          id: dispatch.id,
          order_id: order.id,
          order_no: order.order_no,
          internal_order_no: order.internal_order_no,
          customer_name: order.customer_name,
          style_no: dispatch.style_no || order.style_no || null,
          color: dispatch.color || null,
          factory_id: factory.id,
          factory_name: factory.factory_name,
          planned_qty: Number(dispatch.planned_qty) || null,
          planned_start: toMonthAnchor(dispatch.planned_start || order.factory_date || order.etd),
          planned_end: toMonthAnchor(dispatch.planned_end || order.factory_date || order.etd),
          status: dispatch.status || 'scheduled',
          source: 'dispatch',
          order_factory_date: toMonthAnchor(order.factory_date || order.etd),
        };
        rowsByFactory.set(factory.id, [...(rowsByFactory.get(factory.id) || []), row]);
        const counts = sourceCounts.get(factory.id) || { dispatch: 0, legacy: 0 };
        counts.dispatch += 1;
        sourceCounts.set(factory.id, counts);
      }
      continue;
    }

    const factory = resolveFactoryKey(factoryById, factoryByName, order.factory_id, order.factory_name);
    if (!factory) continue;
    const qty = Number(order.quantity) || 0;
    if (qty <= 0) continue;
    const row: FactoryScheduleDispatchRow = {
      id: `${order.id}:legacy`,
      order_id: order.id,
      order_no: order.order_no,
      internal_order_no: order.internal_order_no,
      customer_name: order.customer_name,
      style_no: order.style_no || null,
      color: null,
      factory_id: factory.id,
      factory_name: factory.factory_name,
      planned_qty: qty,
      planned_start: toMonthAnchor(order.factory_date || order.etd),
      planned_end: toMonthAnchor(order.factory_date || order.etd),
      status: order.has_manufacturing_order ? 'in_production' : 'legacy',
      source: 'legacy',
      order_factory_date: toMonthAnchor(order.factory_date || order.etd),
    };
    rowsByFactory.set(factory.id, [...(rowsByFactory.get(factory.id) || []), row]);
    const counts = sourceCounts.get(factory.id) || { dispatch: 0, legacy: 0 };
    counts.legacy += 1;
    sourceCounts.set(factory.id, counts);
  }

  const fromMonth = new Date().toISOString().slice(0, 7);
  return input.factories.map((factory) => {
    const dispatches = (rowsByFactory.get(factory.id) || []).sort((a, b) => {
      const left = String(a.planned_start || a.order_factory_date || a.order_no || '');
      const right = String(b.planned_start || b.order_factory_date || b.order_no || '');
      return left.localeCompare(right);
    });
    const load = factoryMonthlyLoad(dispatches.map((row) => ({
      planned_qty: row.planned_qty,
      planned_start: row.planned_start,
      planned_end: row.planned_end,
    })));
    const ledger = monthlyLedger(load, factory.monthly_capacity, fromMonth, 6);
    const totalCommitted = dispatches.reduce((sum, row) => sum + (Number(row.planned_qty) || 0), 0);
    const source = sourceCounts.get(factory.id) || { dispatch: 0, legacy: 0 };
    const capacityLabel = factory.monthly_capacity == null
      ? '月产能未配置'
      : Number(factory.monthly_capacity) === 0
        ? '配置产能为0'
        : totalCommitted === 0
          ? '在排 0'
          : '正常';
    const sourceLabel = source.dispatch > 0 ? '新排产真值'
      : source.legacy > 0 ? 'legacy factory assignment'
        : '无数据';
    return {
      id: factory.id,
      factory_name: factory.factory_name,
      factory_code: factory.factory_code || null,
      cooperation_status: factory.cooperation_status || null,
      monthly_capacity: factory.monthly_capacity ?? null,
      product_categories: factory.product_categories || [],
      quality_grades: factory.quality_grades || [],
      weave_types: factory.weave_types || [],
      can_package: factory.can_package ?? null,
      order_capabilities: factory.order_capabilities || [],
      dispatches,
      total_committed: totalCommitted,
      active_count: dispatches.length,
      source_label: sourceLabel,
      capacity_label: capacityLabel,
      ledger,
    };
  });
}
