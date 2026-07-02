/**
 * 尺码标准排序 —— XS→S→M→L→XL→XXL→…,数字码按数值,未知码排最后按字母。
 * 富录入表 / 生产任务单 Excel / 预览 / 款色码摘要共用,保证到处顺序一致。
 */

export const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];

export function compareSizeKeys(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

export function sortSizeKeys(keys: string[]): string[] {
  return [...keys].sort(compareSizeKeys);
}
