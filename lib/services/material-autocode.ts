/**
 * 物料自动编码 —— 分类前缀 + 流水号(FAB-0001 布料 / TRM-0001 辅料 / PKG-0001 包装 …)。
 * 码的唯一真相在 material_master(uq_mm_code 唯一索引);BOM 各入库口(手动/AI识别/布料同步)
 * 通过 ensureMaterialMaster 自动「找同名同类复用码,没有就建正式主数据赋码」,BOM 行带走 code+id 快照。
 * 服务端专用,失败返回 null 绝不阻断 BOM 入库。
 */

export const CODE_PREFIX: Record<string, string> = {
  fabric: 'FAB', trim: 'TRM', packing: 'PKG', print: 'PRT',
  washing: 'WSH', embroidery: 'EMB', service: 'SVC', other: 'OTH',
};

// BOM 专用类别 → 主数据类别(master CHECK 只有 8 值):里料是布,标签归辅料
const BOM_TO_MASTER_CAT: Record<string, string> = { lining: 'fabric', label: 'trim' };

export async function genMaterialCode(supabase: any, category: string, bump = 0): Promise<string> {
  const prefix = CODE_PREFIX[category] || 'OTH';
  const { count } = await supabase.from('material_master')
    .select('id', { count: 'exact', head: true }).eq('category', category);
  return `${prefix}-${String((count || 0) + 1 + bump).padStart(4, '0')}`;
}

export interface EnsureMaterialInput {
  name: string;
  category: string;   // BOM 10 值或 master 8 值都行
  spec?: string | null;
  unit?: string | null;
  supplier?: string | null;
}

/** 找同名同类正式主数据复用码;没有 → 自动建正式主数据赋码(seed_source='bom_auto')。 */
export async function ensureMaterialMaster(
  supabase: any, userId: string, input: EnsureMaterialInput,
): Promise<{ id: string; code: string } | null> {
  try {
    const name = input.name?.trim();
    if (!name) return null;
    const cat = BOM_TO_MASTER_CAT[input.category] || (CODE_PREFIX[input.category] ? input.category : 'other');

    // 1. 同名同类正式料 → 复用(ilike 无通配 = 忽略大小写的等值)
    const { data: hit } = await supabase.from('material_master')
      .select('id, material_code')
      .eq('is_temporary', false).eq('status', 'active').eq('category', cat)
      .ilike('material_name', name)
      .limit(1).maybeSingle();
    if (hit?.material_code) return { id: hit.id, code: hit.material_code };
    if (hit) {
      const code = await genMaterialCode(supabase, cat);
      const { error } = await supabase.from('material_master')
        .update({ material_code: code, updated_at: new Date().toISOString() }).eq('id', hit.id);
      return error ? { id: hit.id, code: '' } : { id: hit.id, code };
    }

    // 2. 自动建正式主数据赋码(count 流水可能撞唯一索引 → 加 bump 重试 3 次)
    for (let i = 0; i < 3; i++) {
      const code = await genMaterialCode(supabase, cat, i);
      const { data, error } = await supabase.from('material_master').insert({
        material_code: code, material_name: name, category: cat,
        default_unit: input.unit || null, specification: input.spec || null,
        default_supplier_name: input.supplier || null,
        is_temporary: false, seed_source: 'bom_auto', created_by: userId,
      }).select('id, material_code').single();
      if (!error) return { id: data.id, code: data.material_code };
      if (!/duplicate|unique/i.test(error.message || '')) return null;
    }
    return null;
  } catch { return null; }
}
