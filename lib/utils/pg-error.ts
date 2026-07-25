/**
 * PostgREST / Postgres「列不存在」类报错工具(2026-07-24 根因6:抽出便于单测)。
 * 用于缺列降级:迁移未落生产 / schema 缓存陈旧时,精准剔掉缺的那一列重试,不连坐好列。
 */

/** 是否「列/表不存在」类报错(区别于约束/非空等真业务错,后者不该降级)。 */
export function isMissingColumnError(msg: string | null | undefined): boolean {
  return /does not exist|schema cache|could not find/i.test(msg || '');
}

/**
 * 从报错里抠出缺失的列名,只返回【在候选可选列里、且未剔过】的那一列。
 * 支持两种格式:
 *   - PostgREST:  Could not find the 'purchase_unit_cost' column of 'order_line_items' in the schema cache
 *   - 原生 PG:    column "purchase_unit_cost" of relation "order_line_items" does not exist
 * 抠不出精确列名 → 退回扫描候选列在报错里的出现。都找不到返回 null。
 */
export function pickMissingColumn(msg: string, candidates: readonly string[], dropped: string[] = []): string | null {
  const m = /column ["']([a-z_]+)["']|["']([a-z_]+)["'] column|the ["']([a-z_]+)["']/i.exec(msg || '');
  let col = (m && (m[1] || m[2] || m[3])) || null;
  if (!col || !candidates.includes(col) || dropped.includes(col)) {
    col = candidates.find((c) => !dropped.includes(c) && new RegExp(`\\b${c}\\b`).test(msg || '')) || null;
  }
  return col && !dropped.includes(col) ? col : null;
}
