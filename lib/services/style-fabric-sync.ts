/**
 * S1.2 每款布料 → materials_bom 同步(source='line_items_sync')。
 * 2026-07-03 升级:每 款×颜色 一行(带 color)—— 没有颜色采购没法下布;
 *   MRP 按该色件数算需求(bom.ts styleColorQty),核料归并按 物料+颜色 分项。
 * 款没录颜色名 → 退回每款一行(无色,按款总量)。
 * 有布料的 款×色 upsert;款删了/色删了/布料清了 → 删对应 sync 行;手工加的 BOM 行不受影响。
 * sync 行以富录入表为准 —— BOM 里改布料会在下次保存明细时被覆盖。
 * 服务端专用(saveOrderLineItems / createOrder 调),不是 server action。
 */

import { findMaterialMaster } from '@/lib/services/material-autocode';
import { normalizeStyleFabrics } from '@/lib/services/style-fabrics';

export async function syncStyleFabricsToBom(supabase: any, orderId: string, userId: string, styles: any[]): Promise<void> {
  const wanted: Array<{ style_no: string; color: string | null; material_name: string; spec: string | null; qty_per_piece: number | null; unit: string; material_id: string | null; material_code: string | null }> = [];
  for (const st of (styles || [])) {
    if (!st?.style_no?.trim()) continue;
    // 每色一行(色名取中文,缺则英文);全款没色名 → 一行无色兜底
    const colorNames = [...new Set(
      (st.colors || [])
        .map((c: any) => (c?.color_cn?.trim() || c?.color_en?.trim() || ''))
        .filter(Boolean)
    )] as string[];
    // 每款可能多种布料 → 每 布料×色 一行(价格不进 BOM,BOM 无价列)
    for (const fb of normalizeStyleFabrics(st)) {
      const base = {
        style_no: st.style_no.trim(),
        material_name: fb.name,
        spec: fb.width || null,
        qty_per_piece: fb.consumption ?? null,
        unit: fb.unit || 'kg',
        material_id: fb.material_id || null,       // 业务从物料库选的才有;手打为 null
        material_code: fb.material_code || null,
      };
      if (colorNames.length > 0) {
        for (const color of colorNames) wanted.push({ ...base, color });
      } else {
        wanted.push({ ...base, color: null });
      }
    }
  }

  const { data: existing } = await supabase.from('materials_bom')
    .select('id, style_no, color, material_name').eq('order_id', orderId).eq('source', 'line_items_sync');
  // 多布料后 key 需含物料名(同款同色可有多种料);旧单料 sync 行凭 material_name 自然重挂,不产生孤儿
  const keyOf = (style: any, color: any, material: any) => `${style || ''}¦${String(color || '').trim()}¦${String(material || '').trim().toLowerCase()}`;
  const existingByKey = new Map<string, string>((existing || []).map((r: any) => [keyOf(r.style_no, r.color, r.material_name), r.id]));

  // 只挂库、不自动补录:业务选的料直接用其 id/码;手打的做只读唯一匹配,匹配不到就留空码(绝不新建主数据,
  // 避免「280g仿锦直贡呢 / 280g直贡呢」这类近义重复被自动灌进物料库)。采购人工建库/去重才是唯一入库口。
  const linkCache = new Map<string, { id: string; code: string } | null>();
  for (const w of wanted) {
    let link: { id: string; code: string } | null;
    if (w.material_id) {
      link = { id: w.material_id, code: w.material_code || '' };   // 已选库条目:直接挂
    } else {
      const cacheKey = `${w.material_name.toLowerCase()}¦${String(w.spec || '').toLowerCase()}`;
      if (!linkCache.has(cacheKey)) {
        linkCache.set(cacheKey, await findMaterialMaster(supabase, { name: w.material_name, category: 'fabric', spec: w.spec }));
      }
      link = linkCache.get(cacheKey) || null;                      // 手打:只读匹配,找不到=留空码不新建
    }
    const patch = {
      material_name: w.material_name, material_type: 'fabric', spec: w.spec,
      qty_per_piece: w.qty_per_piece, unit: w.unit, style_no: w.style_no,
      color: w.color,
      material_code: link?.code || null, material_master_id: link?.id || null,
    };
    const k = keyOf(w.style_no, w.color, w.material_name);
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
