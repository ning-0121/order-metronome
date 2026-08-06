/**
 * 从订单的节点里定出「跟单是谁」—— 必须是确定性的。
 *
 * 【原来是随机的,没人发现】
 * 原写法是 `milestones.find(m => m.owner_role === 'merchandiser' && m.owner_user_id)`,
 * 取第一条。但节点查询**没有 ORDER BY**,PostgREST 返回顺序未定义 ——
 * 也就是说列表上「跟单」显示谁,取决于数据库那次碰巧先返回哪一行。
 *
 * 这不是理论问题:实测 202 张有 merchandiser 节点的单里,**82 张(40%)的
 * merchandiser 节点分属 2~3 个不同的人**(比如同一单里 7 个节点归 A、3 个归 B、1 个归 C)。
 * 2026-08-05 把节点查询的分块从 200 改成 40 之后,返回顺序变了,
 * 「跟单名」的统计数就从 194 变成 195 —— 一个字段的值跟着分块大小飘,这才暴露出来。
 *
 * 【现在的规则】按该单 merchandiser 节点里**出现最多的那个人**;
 * 票数相同则按 user_id 字典序,保证任何时候、任何分块方式下结果都一样。
 * 多数票是对「这单主要是谁在跟」最不意外的读法,不引入新的业务政策。
 *
 * ⚠️ 底层数据本身「一单多跟单」这件事没有解决 —— 那是业务要拍板的口径问题
 * (到底该按主责人、还是按当前阶段的负责人),不是这里能替他们定的。
 */
export function pickMerchandiser(milestones: any[] | undefined): string | null {
  const tally = new Map<string, number>();
  for (const m of milestones || []) {
    if (m?.owner_role !== 'merchandiser' || !m.owner_user_id) continue;
    tally.set(m.owner_user_id, (tally.get(m.owner_user_id) || 0) + 1);
  }
  if (!tally.size) return null;
  return [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),   // 票多优先;同票按 id 定序
  )[0][0];
}
