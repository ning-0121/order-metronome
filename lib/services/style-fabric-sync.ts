/**
 * S1.2 每款布料 → materials_bom 同步(source='line_items_sync',每款至多一行)。
 * 有布料的款 upsert;款删了/布料清了 → 删对应 sync 行;手工加的 BOM 行不受影响。
 * sync 行以富录入表为准 —— BOM 里改布料会在下次保存明细时被覆盖。
 * 服务端专用(saveOrderLineItems / createOrder 调),不是 server action。
 */

export async function syncStyleFabricsToBom(supabase: any, orderId: string, userId: string, styles: any[]): Promise<void> {
  const wanted = (styles || [])
    .filter((st) => st?.style_no?.trim() && st?.fabric_name?.trim())
    .map((st) => {
      const cons = st.fabric_consumption === '' || st.fabric_consumption == null ? null : Number(st.fabric_consumption);
      return {
        style_no: st.style_no.trim(),
        material_name: st.fabric_name.trim(),
        spec: st.fabric_width?.trim() || null,
        qty_per_piece: cons != null && !isNaN(cons) ? cons : null,
        unit: st.fabric_unit?.trim() || 'kg',
      };
    });

  const { data: existing } = await supabase.from('materials_bom')
    .select('id, style_no').eq('order_id', orderId).eq('source', 'line_items_sync');
  const existingByStyle = new Map<string, string>((existing || []).map((r: any) => [r.style_no || '', r.id]));

  for (const w of wanted) {
    const patch = {
      material_name: w.material_name, material_type: 'fabric', spec: w.spec,
      qty_per_piece: w.qty_per_piece, unit: w.unit, style_no: w.style_no,
    };
    const exist = existingByStyle.get(w.style_no);
    if (exist) {
      await supabase.from('materials_bom').update(patch).eq('id', exist);
      existingByStyle.delete(w.style_no);
    } else {
      await supabase.from('materials_bom').insert({ ...patch, order_id: orderId, created_by: userId, source: 'line_items_sync' });
    }
  }
  // 剩下的 = 款已删或布料已清 → 删 sync 行
  const staleIds = [...existingByStyle.values()];
  if (staleIds.length > 0) await supabase.from('materials_bom').delete().in('id', staleIds);
}
