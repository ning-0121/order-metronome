/**
 * Truth Query 基建 —— R1-E Truth Gate(2026-08-09)。
 *
 * ONE BUSINESS TRUTH:管理层数字不允许被 PostgREST 1000 行上限静默截断。
 * 体检实锤:CEO 驾驶舱 4 个月新逾期隐身、完成率虚高 4pp、角色评分只算 26% 样本、
 * Agent 页头部 count 2927 下方分布合计 1000 自相矛盾 —— 全是同一个模式:
 * **无界 .select() 拉"全量"再在 Node 里算 KPI,实际只拿到前 1000 行**。
 *
 * 两条铁律:
 *   聚合指标(count/sum/分布)→ getExactCount / DB 聚合,别拉明细;
 *   真需要全量明细 → fetchAllPages(),禁止裸 .select() 装全量。
 * 静态闸 lint:truth 盯 CEO/analytics/评分/财务路径防回潮。
 */

const PAGE = 1000;
const HARD_MAX = 100_000;   // 失控保护:超过说明该用聚合而不是拉明细

/**
 * 分页取全量。mkQuery 每页调用一次,必须返回**新建**的查询(builder 不能复用):
 *   fetchAllPages((from, to) => svc.from('milestones').select('...').eq(...).range(from, to))
 */
export async function fetchAllPages<T = any>(
  mkQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<{ rows: T[]; error?: string; pages: number }> {
  const rows: T[] = [];
  let pages = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await mkQuery(from, from + PAGE - 1);
    if (error) return { rows, error: error.message || String(error), pages };
    pages++;
    rows.push(...(data || []));
    if ((data || []).length < PAGE) break;
    if (rows.length >= HARD_MAX) return { rows, error: `超出 ${HARD_MAX} 行保护上限 —— 该指标应改用聚合查询`, pages };
  }
  return { rows, pages };
}

/** 精确计数(head 请求,不传数据行)—— 计数永远别拉明细 */
export async function getExactCount(
  mkQuery: () => PromiseLike<{ count: number | null; error: any }>,
): Promise<{ count: number; error?: string }> {
  const { count, error } = await mkQuery();
  if (error) return { count: 0, error: error.message || String(error) };
  return { count: count ?? 0 };
}

/**
 * 全量明细 + 与精确计数对账:两者对不上 = 有截断/口径漂移,**宁可报错不给假数**。
 * CEO/评分类指标用这个,别用裸 fetchAllPages。
 */
export async function fetchAllVerified<T = any>(
  mkQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  mkCount: () => PromiseLike<{ count: number | null; error: any }>,
): Promise<{ rows: T[]; error?: string }> {
  const [{ rows, error: pageErr }, { count, error: cntErr }] = await Promise.all([
    fetchAllPages<T>(mkQuery), getExactCount(mkCount),
  ]);
  if (pageErr) return { rows: [], error: `分页取数失败: ${pageErr}` };
  if (cntErr) return { rows: [], error: `计数失败: ${cntErr}` };
  if (rows.length !== count) {
    return { rows: [], error: `全量校验失败:取到 ${rows.length} 行 ≠ 精确计数 ${count}(截断或并发漂移)—— 拒绝输出假数字` };
  }
  return { rows };
}
