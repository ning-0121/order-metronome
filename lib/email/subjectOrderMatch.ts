/**
 * 邮件主题 → 订单自动匹配(2026-07-27 CEO)。纯函数、零 token:抽主题里的订单号/款号引用,
 * 对"真实 ref 索引"(订单内部号/系统号 + 逐款 style_no)做**精确匹配**——只命中库里真存在的号,
 * 极少误匹配。命中 → 邮件自动绑单 → 客户名/业务执行负责人自动带出。
 * 同号多单(返单)取最近创建的那单。
 */

export interface RefRow { id: string; internal_order_no?: string | null; order_no?: string | null; style_no?: string | null; created_at?: string | null }

/** 归一化:大写 + 去空格/连字符/下划线/井号(3301978-2 与 33019782、31508 BO 与 31508BO 视同) */
export function normRef(s: string | null | undefined): string {
  return String(s || '').toUpperCase().replace(/[\s\-_#]/g, '');
}

/** 建 ref(归一) → orderId 索引;同 ref 多单取最近 created_at。 */
export function buildOrderRefIndex(rows: RefRow[]): Map<string, string> {
  const best = new Map<string, { orderId: string; at: string }>();
  const put = (ref: string | null | undefined, id: string, at: string) => {
    const k = normRef(ref);
    if (k.length < 3) return;   // 太短(≤2)不进索引,避免噪音
    const cur = best.get(k);
    if (!cur || at > cur.at) best.set(k, { orderId: id, at });
  };
  for (const r of rows) {
    const at = String(r.created_at || '');
    put(r.internal_order_no, r.id, at);
    put(r.order_no, r.id, at);
    put(r.style_no, r.id, at);
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.orderId]));
}

/** 从主题抽候选 token,归一后在索引里找;长 token(更具体)优先,首个命中即返回 orderId。 */
export function matchSubjectToOrder(subject: string | null | undefined, index: Map<string, string>): string | null {
  const raw = String(subject || '').match(/[A-Za-z0-9][A-Za-z0-9\-_]{1,}/g) || [];
  const cands = [...new Set(raw.map(normRef))].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
  for (const t of cands) {
    const hit = index.get(t);
    if (hit) return hit;
  }
  return null;
}
