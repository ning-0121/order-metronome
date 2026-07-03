/**
 * S1.2 每款布料 → materials_bom 同步(source='line_items_sync')。
 * 2026-07-03 升级:每 款×颜色 一行(带 color)—— 没有颜色采购没法下布;
 *   MRP 按该色件数算需求(bom.ts styleColorQty),核料归并按 物料+颜色 分项。
 * 款没录颜色名 → 退回每款一行(无色,按款总量)。
 * 有布料的 款×色 upsert;款删了/色删了/布料清了 → 删对应 sync 行;手工加的 BOM 行不受影响。
 * sync 行以富录入表为准 —— BOM 里改布料会在下次保存明细时被覆盖。
 * 服务端专用(saveOrderLineItems / createOrder 调),不是 server action。
 */

import { ensureMaterialMaster } from '@/lib/services/material-autocode';

export async function syncStyleFabricsToBom(supabase: any, orderId: string, userId: string, styles: any[]): Promise<void> {
  const wanted: Array<{ style_no: string; color: string | null; material_name: string; spec: string | null; qty_per_piece: number | null; unit: string }> = [];
  for (const st of (styles || [])) {
    if (!st?.style_no?.trim() || !st?.fabric_name?.trim()) continue;
    const cons = st.fabric_consumption === '' || st.fabric_consumption == null ? null : Number(st.fabric_consumption);
    const base = {
      style_no: st.style_no.trim(),
      material_name: st.fabric_name.trim(),
      spec: st.fabric_width?.trim() || null,
      qty_per_piece: cons != null && !isNaN(cons) ? cons : null,
      unit: st.fabric_unit?.trim() || 'kg',
    };
    // 每色一行(色名取中文,缺则英文);全款没色名 → 一行无色兜底
    const colorNames = [...new Set(
      (st.colors || [])
        .map((c: any) => (c?.color_cn?.trim() || c?.color_en?.trim() || ''))
        .filter(Boolean)
    )] as string[];
    if (colorNames.length > 0) {
      for (const color of colorNames) wanted.push({ ...base, color });
    } else {
      wanted.push({ ...base, color: null });
    }
  }

  const { data: existing } = await supabase.from('materials_bom')
    .select('id, style_no, color').eq('order_id', orderId).eq('source', 'line_items_sync');
  const keyOf = (style: any, color: any) => `${style || ''}¦${String(color || '').trim()}`;
  const existingByKey = new Map<string, string>((existing || []).map((r: any) => [keyOf(r.style_no, r.color), r.id]));

  // 同款同料只 ensure 一次主数据码
  const codeCache = new Map<string, { id: string; code: string } | null>();
  for (const w of wanted) {
    const cacheKey = `${w.material_name.toLowerCase()}¦${String(w.spec || '').toLowerCase()}`;
    if (!codeCache.has(cacheKey)) {
      codeCache.set(cacheKey, await ensureMaterialMaster(supabase, userId, {
        name: w.material_name, category: 'fabric', spec: w.spec, unit: w.unit,
      }));
    }
    const auto = codeCache.get(cacheKey);
    const patch = {
      material_name: w.material_name, material_type: 'fabric', spec: w.spec,
      qty_per_piece: w.qty_per_piece, unit: w.unit, style_no: w.style_no,
      color: w.color,
      material_code: auto?.code || null, material_master_id: auto?.id || null,
    };
    const k = keyOf(w.style_no, w.color);
    const exist = existingByKey.get(k);
    if (exist) {
      await supabase.from('materials_bom').update(patch).eq('id', exist);
      existingByKey.delete(k);
    } else {
      await supabase.from('materials_bom').insert({ ...patch, order_id: orderId, created_by: userId, source: 'line_items_sync' });
    }
  }
  // 剩下的 = 款/色已删或布料已清 → 删 sync 行(含旧版无色行,升级后自动被按色新行替代)
  const staleIds = [...existingByKey.values()];
  if (staleIds.length > 0) await supabase.from('materials_bom').delete().in('id', staleIds);
}
