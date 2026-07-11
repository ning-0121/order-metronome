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
