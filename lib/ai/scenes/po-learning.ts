export type POLearningProfile = {
  version: 1;
  commonSizeLabels: string[];
  commonSetMultipliers: number[];
  correctedFields: string[];
  styleCountRange: [number, number];
};

const clean = (value: unknown) => String(value ?? '').trim().slice(0, 40);

export function normalizeCustomerKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/** Build a compact, non-financial profile from an explicit human correction. */
export function buildPOLearningProfile(original: any, correctedStyles: any[]): POLearningProfile {
  const originalStyles = Array.isArray(original?.styles) ? original.styles : [];
  const sizes = new Set<string>();
  const multipliers = new Set<number>();
  for (const style of correctedStyles) {
    const multiplier = Number(style?.set_multiplier);
    if (Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 10) multipliers.add(multiplier);
    for (const color of (Array.isArray(style?.colors) ? style.colors : [])) {
      for (const label of Object.keys(color?.sizes || {})) {
        const safe = clean(label); if (safe) sizes.add(safe);
      }
    }
  }
  const correctedFields = new Set<string>();
  if (originalStyles.length !== correctedStyles.length) correctedFields.add('styles');
  const originalByStyle = new Map(originalStyles.map((s: any) => [clean(s?.style_no), s]));
  for (const style of correctedStyles) {
    const before: any = originalByStyle.get(clean(style?.style_no));
    if (!before) { correctedFields.add('style_mapping'); continue; }
    if (clean(before.product_name) !== clean(style?.product_name)) correctedFields.add('product_name');
    const beforeSizes = new Set((before.colors || []).flatMap((c: any) => Object.keys(c?.sizes || {})));
    const afterSizes = new Set((style.colors || []).flatMap((c: any) => Object.keys(c?.sizes || {})));
    if ([...beforeSizes].sort().join('|') !== [...afterSizes].sort().join('|')) correctedFields.add('size_labels');
    if ((before.colors || []).length !== (style.colors || []).length) correctedFields.add('colors');
  }
  return {
    version: 1,
    commonSizeLabels: [...sizes].slice(0, 30),
    commonSetMultipliers: [...multipliers].sort((a, b) => a - b),
    correctedFields: [...correctedFields].sort(),
    styleCountRange: [correctedStyles.length, correctedStyles.length],
  };
}

export function formatPOLearningContext(profiles: POLearningProfile[]): string {
  if (!profiles.length) return '';
  const sizes = [...new Set(profiles.flatMap(p => p.commonSizeLabels))].slice(0, 30);
  const multipliers = [...new Set(profiles.flatMap(p => p.commonSetMultipliers))].sort((a, b) => a - b);
  const corrected = [...new Set(profiles.flatMap(p => p.correctedFields))].slice(0, 12);
  return `\n\n【同客户已人工确认的历史结构经验】\n` +
    `这些只是识别提示，不是事实；必须以当前 PO 为准，冲突时当前 PO 优先。\n` +
    `常见尺码标签：${sizes.join(', ') || '无'}\n` +
    `历史套装倍率：${multipliers.join(', ') || '无'}\n` +
    `历史上经常被人工纠正的字段：${corrected.join(', ') || '无'}；这些字段本次要重点核对，不能照抄历史值。`;
}
