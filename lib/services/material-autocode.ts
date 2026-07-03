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

/**
 * 找 同名+同类+同规格 正式主数据复用码;没有 → 自动建正式主数据赋码(seed_source='bom_auto')。
 * 2026-07-03 变体模式:同名布料可有多行(规格=克重/门幅 区分)。匹配规则:
 *  - 录入带规格 → 按规格精确配;配不上 → 建新变体行;
 *  - 录入无规格 → 同名只有一行才复用;有多行变体 = 歧义,不瞎猜(返回 null,BOM 行留空码,人来定)。
 */
export async function ensureMaterialMaster(
  supabase: any, userId: string, input: EnsureMaterialInput,
): Promise<{ id: string; code: string } | null> {
  try {
    const name = input.name?.trim();
    if (!name) return null;
    const cat = BOM_TO_MASTER_CAT[input.category] || (CODE_PREFIX[input.category] ? input.category : 'other');
    const norm = (s: any) => String(s ?? '').trim().toLowerCase();
    const inSpec = norm(input.spec);

    // 同名同类候选(ilike 无通配 = 忽略大小写的等值),再按规格挑
    const pickMatch = async (): Promise<any | 'ambiguous' | null> => {
      const { data: rows } = await supabase.from('material_master')
        .select('id, material_code, specification')
        .eq('is_temporary', false).eq('status', 'active').eq('category', cat)
        .ilike('material_name', name)
        .limit(20);
      const list = rows || [];
      if (list.length === 0) return null;
      const specHit = list.find((r: any) => norm(r.specification) === inSpec);
      if (specHit) return specHit;                       // 规格精确命中(含 双方都空)
      if (inSpec) return null;                           // 带规格但没这个变体 → 建新行
      return list.length === 1 ? list[0] : 'ambiguous';  // 无规格:唯一才复用,多变体不瞎猜
    };

    // 1. 复用已有行(缺码则补码)
    const hit = await pickMatch();
    if (hit === 'ambiguous') return null;
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
      // 撞唯一可能是 名称+类别+规格 索引(并发下别人刚建了同变体)→ 重查直接复用,别再空转赋码
      const again = await pickMatch();
      if (again && again !== 'ambiguous') return { id: again.id, code: again.material_code || '' };
      if (again === 'ambiguous') return null;
    }
    return null;
  } catch { return null; }
}
