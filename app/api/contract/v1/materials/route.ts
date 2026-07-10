// GET /api/contract/v1/materials?q=&category=&limit=
// 共享物料主数据(采购部物料库)只读端点 —— 供 araos 打样「建立产品信息」时选面料/辅料。
// scope: commercial.read。⚠️ 绝不返回任何价格(reference_price / 供应商单价)——araos 永不可见成本。
// 只暴露物料身份/规格/单位/分类/参考图，足够选料建 BOM。

import { withContract } from '@/app/api/contract/v1/_lib/withContract';

interface MaterialRow {
  id: string;
  material_code: string | null;
  material_name: string | null;
  category: string | null;
  specification: string | null;
  default_unit: string | null;
  image_url: string | null;
}

export const GET = withContract<Record<string, string>>(
  { routeTemplate: '/api/contract/v1/materials', entityType: 'material' },
  async ({ supabase, request }) => {
    const url = new URL(request.url);
    // 过滤输入清洗：去掉会破坏 .or()/ilike 语法的字符。
    const q = (url.searchParams.get('q') || '').replace(/[,()%*\\]/g, ' ').trim();
    const category = (url.searchParams.get('category') || '').replace(/[,()%*\\]/g, ' ').trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);

    let query = supabase
      .from('material_master')
      .select('id, material_code, material_name, category, specification, default_unit, image_url')
      .eq('status', 'active')
      .order('usage_count', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (category) query = query.eq('category', category);
    if (q) query = query.or(`material_name.ilike.%${q}%,material_code.ilike.%${q}%,specification.ilike.%${q}%`);

    const { data } = await query;
    const materials = (data as MaterialRow[] | null) ?? [];
    return { entityId: null, data: { materials, count: materials.length } };
  },
);
