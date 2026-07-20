export type FactoryTruthSource = 'order' | 'dispatch' | 'none';

export type FactoryTruth = {
  factory_id: string | null;
  factory_name: string | null;
  source: FactoryTruthSource;
};

/** orders is canonical; active production_dispatch is the compatibility truth for historical style dispatches. */
export function resolveFactoryTruth(
  order: { factory_id?: string | null; factory_name?: string | null },
  dispatches: Array<{ factory_id?: string | null; factory_name?: string | null; status?: string | null; created_at?: string | null }> = [],
): FactoryTruth {
  if (String(order.factory_id || order.factory_name || '').trim()) {
    return { factory_id: order.factory_id || null, factory_name: order.factory_name || null, source: 'order' };
  }
  const active = dispatches
    .filter((row) => !['cancelled', 'done'].includes(String(row.status || '').toLowerCase()))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .find((row) => String(row.factory_id || row.factory_name || '').trim());
  return active
    ? { factory_id: active.factory_id || null, factory_name: active.factory_name || null, source: 'dispatch' }
    : { factory_id: null, factory_name: null, source: 'none' };
}
