/**
 * 数据库错误 → 业务友好文案
 *
 * 问题背景：之前 server action 普遍写 `return { error: error.message }`，
 * 把 Supabase 的原始报错（含表名 / 列名 / RLS policy 名 / SQL 约束语法）
 * 直接返回给业务用户。例：
 *
 *   "duplicate key value violates unique constraint
 *    \"order_attachments_order_id_milestone_id_file_type_key\""
 *
 * 业务看不懂、技术信息泄露（攻击者可推断 schema）。
 *
 * 这里把常见 Supabase error code 映射成中文业务文案；其他情况返回 fallback
 * 或一个泛化提示。完整原文进 console.warn 供运维排查。
 *
 * Usage:
 *   const { data, error } = await supabase.from('xxx').insert(...);
 *   if (error) return { error: friendlyError(error, '保存失败，请重试') };
 */

interface PgError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

const KNOWN_CODES: Record<string, string> = {
  // PostgreSQL standard codes
  '23505': '已存在相同记录（请检查唯一字段是否重复）',
  '23503': '关联记录不存在或已被删除',
  '23502': '必填字段缺失',
  '23514': '数据不符合约束规则',
  '23P01': '当前数据不满足排他约束',
  // Supabase / PostgREST codes
  '42501': '无权操作此数据（RLS 策略拒绝）',
  '42P01': '系统错误：相关数据表不存在，请联系管理员',
  'PGRST116': '记录不存在或已被删除',
  'PGRST301': '无权访问此记录',
  // Auth / session
  '401': '请先登录',
};

/**
 * 把 Supabase / Postgres error 转成业务友好的中文文案
 *
 * @param err     原始 error 对象（含 code / message）
 * @param fallback 找不到 code 映射时的兜底文案（默认「操作失败，请稍后重试」）
 */
export function friendlyError(
  err: PgError | string | null | undefined,
  fallback: string = '操作失败，请稍后重试',
): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;

  // 把原始错误打到日志（运维 / 排查可见，但不返回客户端）
  console.warn('[db-error]', { code: err.code, message: err.message, details: err.details });

  if (err.code && KNOWN_CODES[err.code]) {
    return KNOWN_CODES[err.code];
  }

  // 兜底：返回 fallback，不暴露原始 message
  return fallback;
}
