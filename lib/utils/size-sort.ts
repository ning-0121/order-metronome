/**
 * 尺码标准排序 —— 全链唯一真相源。
 * XXXS…XS→S→M→L→XL→XXL… 字母码;童装/欧码等纯数字码按数值;未知码排最后按字母。
 * 富录入表 / 生产任务单 / 采购项 / 采购单 Excel / 出货单据 / 预览 / 款色码摘要 全部共用,保证到处顺序一致。
 *
 * 归一规则(下游别再自造 SIZE_ORDER):
 * - 大小写无关:xl == XL == Xl
 * - 重复 X 与数字前缀等价:XXL == 2XL,XXXL == 3XL,XXS == 2XS(同级不再乱序)
 * - 纯数字码(90/100/110、34/36/38)按数值升序,排在字母码之后
 * - 都认不出:按字母序,靠 stable sort 保原始录入序
 */

// 展示锚点(仅供需要固定列头的场景引用;排序本身用 compareSizeKeys,不依赖此数组的下标)
export const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL'];

/**
 * 这个 key 是不是**真尺码**(2026-08-17 配比分摊事故)。
 *
 * 事故:Excel/AI 解析客户订单表时,表头里的**数据列**会被当成尺码列一起吸进 sizeLabels ——
 * 生产库里 `QTY (PCS)` 就作为"尺码"存在 26 行明细 / 3 张单(587、613、1022987-614)。
 * 一旦它进了尺码列,就会参与「按配比分摊总量」:
 *   配比 S:M:L:XL = 1:2:2:1 本该 6 份,混进 QTY 那一份变成 **7 份**,
 *   5184 ÷ 7 = 740.57 → 摊成 741/1481/1481/741/740(正确应为 864/1728/1728/864)。
 * 配比看着是对的,总量也对得上,唯独每码数量全错 —— 极难看出来。
 *
 * 用**黑名单**不用白名单:真尺码写法太杂(1X/2X/3X/G/P/GG/XXL/纯数字码…),
 * 白名单一定会误杀;而"数量/小计/箱数/金额"这类数据列的词是有限且明确的。
 */
const NON_SIZE_PATTERN = /(qty|pcs|数量|小计|总量|总数|箱数|箱|total|subtotal|合计|金额|单价|price|amount)/i;

export function isSizeLabel(key: unknown): boolean {
  const s = String(key ?? '').trim();
  if (!s) return false;
  return !NON_SIZE_PATTERN.test(s);
}

/** 过滤掉混进来的非尺码列。入口(解析/DB 恢复/外部塞入)和分摊前都该走一遍。 */
export function keepSizeLabels(keys: Iterable<string>): string[] {
  return [...keys].filter(isSizeLabel);
}

/**
 * 字母码 → 有序数值(M=0,越大越正,越小越负);非字母码返回 null。
 * XS=-2 / XXS(2XS)=-3 / XXXS(3XS)=-4 …  XL=+2 / XXL(2XL)=+3 / XXXL(3XL)=+4 …
 */
function letterRank(raw: string): number | null {
  const s = String(raw).trim().toUpperCase();
  if (s === 'M') return 0;
  if (s === 'S') return -1;
  if (s === 'L') return 1;
  let m = s.match(/^(\d+)\s*X([SL])$/);   // 2XL / 3XS(数字前缀)
  if (m) { const c = parseInt(m[1], 10); return m[2] === 'L' ? 1 + c : -(1 + c); }
  m = s.match(/^(X+)([SL])$/);            // XL / XXL / XS / XXS(重复 X)
  if (m) { const c = m[1].length; return m[2] === 'L' ? 1 + c : -(1 + c); }
  return null;
}

export function compareSizeKeys(a: string, b: string): number {
  const ra = letterRank(a), rb = letterRank(b);
  if (ra !== null && rb !== null) return ra - rb;
  if (ra !== null) return -1;   // 字母码排在纯数字/未知码之前
  if (rb !== null) return 1;
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

export function sortSizeKeys(keys: string[]): string[] {
  return [...keys].sort(compareSizeKeys);
}

/**
 * 带「显式顺序」的比较器工厂 —— 业务在富录入表手排的顺序(orders.size_order)优先;
 * 显式列出的按其下标排在最前,未列出的码退回标准自动序(compareSizeKeys)排在其后。
 * explicit 为空/未传时 === compareSizeKeys(纯自动排)。全链下游共用,保证到处跟手排一致。
 */
export function sizeComparator(explicit?: string[] | null): (a: string, b: string) => number {
  if (!explicit || explicit.length === 0) return compareSizeKeys;
  const idx = new Map<string, number>();
  explicit.forEach((s, i) => { const k = String(s).trim().toUpperCase(); if (!idx.has(k)) idx.set(k, i); });
  const rank = (s: string) => { const r = idx.get(String(s).trim().toUpperCase()); return r === undefined ? -1 : r; };
  return (a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== -1 && rb !== -1) return ra - rb;
    if (ra !== -1) return -1;   // 手排列出的排前
    if (rb !== -1) return 1;
    return compareSizeKeys(a, b);   // 都没列出:标准自动序
  };
}

/**
 * 有显式顺序按它排(未列出的码标准序附末尾);无则回落标准自动排序。
 *
 * **会去重** —— 2026-08-04 事故:生产单导出把 10 个颜色行的尺码键
 * `colors.flatMap(c => Object.keys(c.sizes))` 直接传进来(10 行 × 5 码 = 50 个),
 * 这里当时只排序不去重,排完重复的正好挤在一起 → 导出的生产单变成
 * 「S S S S S S S S S S M M M …」50 列(CEO 报障:1022978 圣安娜)。
 * 「排列尺码键」这件事本身就不该返回重复,所以在根上去重,而不是让每个调用方各自记得去重
 * (其余 8 处调用传的都是 Set 展开、本来就唯一,加这层零影响)。
 */
export function orderSizeKeys(keys: string[], explicit?: string[] | null): string[] {
  return [...new Set(keys)].sort(sizeComparator(explicit));
}
