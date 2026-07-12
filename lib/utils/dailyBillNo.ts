/**
 * 单号生成共享工具(2026-07-12 审计 P2-5)。
 * 口径:PREFIX-YYYYMMDD-NNN,取【当天已存在最大序号 + 1】(删记录不复用空缺号),
 *   配合唯一键冲突自增重试(防并发撞号)。收敛 procurement-payment(PR/DP)/ supplier-ledger(LG)
 *   等各处「全表 count+1」老套路(删记录会缩水撞号 + 非原子)。
 *
 * 用法:
 *   const next = makeDailyBillNo(client, 'supplier_ledger_payables', 'bill_no', 'LG');
 *   for (let attempt = 0; attempt < 6; attempt++) {
 *     const billNo = await next(attempt);
 *     const { error } = await client.from(...).insert({ bill_no: billNo, ... });
 *     if (!error) break;
 *     if (!/duplicate key|_key/i.test(error.message || '')) break; // 非撞号错误立即抛
 *   }
 */
export function makeDailyBillNo(client: any, table: string, column: string, prefix: string) {
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const p = `${prefix}-${dateTag}-`;
  return async (bump = 0): Promise<string> => {
    const { data } = await (client.from(table) as any).select(column).like(column, `${p}%`);
    let maxN = 0;
    for (const r of (data || []) as any[]) {
      const m = /-(\d+)$/.exec(String(r[column] || ''));
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `${p}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };
}
