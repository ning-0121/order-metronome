export const PR31_FIXTURE_TYPE = 'PR31_BUDGET_UAT' as const;

export const PR31_FIXTURE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'UAT_COMPLETE',
  'CLEANUP_PENDING',
  'CLEANED',
  'EXPIRED',
] as const;

export type Pr31FixtureStatus = typeof PR31_FIXTURE_STATUSES[number];

export type Pr31FixtureAsset = {
  assetTable: string;
  assetId: string;
  assetRole: 'order' | 'bom' | 'baseline' | 'attachment' | 'document';
  cleanupMode: 'delete' | 'restore';
};

export type Pr31FixtureRecord = {
  id: string;
  fixtureType: typeof PR31_FIXTURE_TYPE;
  status: Pr31FixtureStatus;
  ownerUserId: string;
  expiresAt: string | null;
  targetOrderId: string | null;
  targetBomId: string | null;
  targetBaselineId: string | null;
};

const STATUS_ORDER: Pr31FixtureStatus[] = [
  'DRAFT',
  'ACTIVE',
  'UAT_COMPLETE',
  'CLEANUP_PENDING',
  'CLEANED',
  'EXPIRED',
];

export function isPr31FixtureType(value: unknown): value is typeof PR31_FIXTURE_TYPE {
  return value === PR31_FIXTURE_TYPE;
}

export function isAllowedFixtureTransition(from: Pr31FixtureStatus, to: Pr31FixtureStatus): boolean {
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  if (from === to) return true;
  if (from === 'EXPIRED' || from === 'CLEANED') return false;
  if (from === 'ACTIVE') return ['UAT_COMPLETE', 'CLEANUP_PENDING', 'EXPIRED'].includes(to);
  if (from === 'UAT_COMPLETE') return ['CLEANUP_PENDING', 'EXPIRED'].includes(to);
  if (from === 'CLEANUP_PENDING') return to === 'CLEANED';
  if (from === 'DRAFT') return ['ACTIVE', 'EXPIRED'].includes(to);
  return false;
}

export function normalizeBudgetUnitPriceInput(
  input: number | string | null | undefined,
  options: { allowZero: boolean } = { allowZero: true },
): { value: number | null; error: string | null } {
  if (input === null || input === undefined || input === '') {
    return { value: null, error: null };
  }
  const num = typeof input === 'number' ? input : Number(String(input).trim());
  if (!Number.isFinite(num)) return { value: null, error: '预算单价必须是有效数字' };
  if (num < 0) return { value: null, error: '预算单价不能为负数' };
  if (num === 0 && !options.allowZero) return { value: null, error: '当前业务规则不允许保存 0' };
  const normalized = Number(num.toFixed(6));
  return { value: normalized, error: null };
}

export function canCleanupFixture(record: Pr31FixtureRecord, now = new Date()): { ok: boolean; reason?: string } {
  if (!isPr31FixtureType(record.fixtureType)) return { ok: false, reason: 'fixture type mismatch' };
  if (record.status !== 'ACTIVE' && record.status !== 'CLEANUP_PENDING') {
    return { ok: false, reason: `fixture status ${record.status} is not cleanable` };
  }
  if (record.expiresAt && new Date(record.expiresAt) < now) {
    return { ok: false, reason: 'fixture expired' };
  }
  if (!record.targetOrderId || !record.targetBomId) {
    return { ok: false, reason: 'missing target order or bom' };
  }
  return { ok: true };
}

export function validateCleanupAssets(assets: Pr31FixtureAsset[], expectedFixtureId: string): { ok: boolean; reason?: string } {
  if (!expectedFixtureId) return { ok: false, reason: 'missing fixture id' };
  if (assets.some((asset) => !asset.assetId || !asset.assetTable)) {
    return { ok: false, reason: 'invalid asset reference' };
  }
  return { ok: true };
}
