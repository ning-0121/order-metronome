/**
 * 每款多种布料的规范化(富录入表 S1.2 多布料)。
 * 单条形状:{ material_id, name, width, consumption, unit, price }
 *   price = 采购参考单价(¥),只登记/带出参考,不参与自动成本(老板口径 2026-07-10)。
 * 兼容:优先读 st.fabrics 数组;缺则用旧的 fabric_name/width/consumption/unit 合成单条。
 * 服务端 / 客户端通用(纯函数,无副作用、无 server-only 依赖)。
 */

export type StyleFabric = {
  material_id?: string | null;    // 关联物料库(仅当业务从库里选;手打为 null,不自动建库)
  material_code?: string | null;  // 选中时带走的编码快照
  name: string;
  width?: string | null;
  consumption?: number | null;
  unit?: string;
  price?: number | null;
};

function num(v: any): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** 从一个款(受控/落库两种形状皆可)取出规范化布料列表;丢空名行。 */
export function normalizeStyleFabrics(st: any): StyleFabric[] {
  const raw = Array.isArray(st?.fabrics) && st.fabrics.length > 0
    ? st.fabrics
    : (st?.fabric_name
        ? [{ name: st.fabric_name, width: st.fabric_width, consumption: st.fabric_consumption, unit: st.fabric_unit, price: null, material_id: null }]
        : []);
  const out: StyleFabric[] = [];
  for (const f of raw) {
    const name = String(f?.name ?? '').trim();
    if (!name) continue;
    const width = f?.width == null ? null : (String(f.width).trim() || null);
    out.push({
      material_id: f?.material_id ?? null,
      material_code: f?.material_code ?? null,
      name,
      width,
      consumption: num(f?.consumption),
      unit: (f?.unit && String(f.unit).trim()) || 'kg',
      price: num(f?.price),
    });
  }
  return out;
}

/** 第一条布料镜像回旧 fabric_* 列(向后兼容:老读者只认单条)。 */
export function primaryFabricColumns(fabrics: StyleFabric[]): {
  fabric_name: string | null; fabric_width: string | null;
  fabric_consumption: number | null; fabric_unit: string | null;
} {
  const first = fabrics[0];
  return {
    fabric_name: first?.name || null,
    fabric_width: first?.width || null,
    fabric_consumption: first?.consumption ?? null,
    fabric_unit: first?.unit || null,
  };
}
