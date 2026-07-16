export const CONSUMPTION_UNITS = ['米/件', '平方米/件', 'kg/件', '码/件', '其他'] as const;

export function normalizeConsumptionUnit(value: unknown): string {
  const unit = String(value ?? '').trim().toLowerCase();
  if (['m', '米', '米/件'].includes(unit)) return '米/件';
  if (['m2', 'm²', '㎡', '平方米', '平方', '平方米/件'].includes(unit)) return '平方米/件';
  if (['kg', '公斤', 'kg/件'].includes(unit)) return 'kg/件';
  if (['yard', 'yd', '码', '码/件'].includes(unit)) return '码/件';
  return unit ? '其他' : '';
}

export function normalizeConsumptionDecimal(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) return null;
  return raw;
}

export function compareConsumption(input: { quoted: unknown; actual: unknown; quotedUnit: unknown; actualUnit: unknown }) {
  const quoted = normalizeConsumptionDecimal(input.quoted);
  const actual = normalizeConsumptionDecimal(input.actual);
  const quotedUnit = normalizeConsumptionUnit(input.quotedUnit);
  const actualUnit = normalizeConsumptionUnit(input.actualUnit);
  if (!quoted || !actual) return { ok: false as const, error: '单耗格式不正确，最多保留6位小数' };
  if (!quotedUnit || !actualUnit) return { ok: false as const, error: '请确认报价单耗和实际单耗的单位' };
  if (quotedUnit !== actualUnit) return { ok: false as const, error: `单耗单位不一致：报价 ${quoted} ${quotedUnit}，实际 ${actual} ${actualUnit}。请先明确换算，系统不会自动转换。` };
  if (Number(actual) > Number(quoted)) return { ok: false as const, error: `实际单耗（${actual} ${actualUnit}）超过报价单耗（${quoted} ${quotedUnit}），不允许开裁。请与工厂沟通优化排料方案。` };
  return { ok: true as const, quoted, actual, unit: actualUnit };
}
