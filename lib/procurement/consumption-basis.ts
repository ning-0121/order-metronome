// ============================================================
// consumption_basis 确认 —— BOM truth 的一部分,归跟单(2026-08-13 CEO 拍板)
//
// 责任边界:
//   跟单 = BOM truth owner      物料 / 规格 / 颜色 / 单耗 / **consumption_basis**
//   系统 = requirement calculator 需求量 / required date
//   采购 = procurement truth     供应商 / 价格 / 承诺到货日
//
// 为什么 basis 不能让采购判断:单耗是跟单填的,只有他知道 0.88kg 是「每套」还是「每件」。
// 推给采购 = 让不知情的人猜,而 basis 猜错后面数量直接差 2 倍(1022977/1022967 已实证)。
//
// ⚠️ 注意 lib/domain/quantity-engine.ts 里多处写 `basis || 'PER_SET'` —— 那个静默兜底
// 正是「未确认被当成已确认」的通道。本模块的门禁就是在数据流到那些默认值**之前**拦住。
// ============================================================

import type { QuantityBasis } from '@/lib/domain/quantity-engine';

/** 跟单在 BOM 页可选的口径(不暴露全部 QuantityBasis —— 计量类由单位推导,不让人选错)。 */
export const BASIS_OPTIONS: Array<{ value: QuantityBasis; label: string; hint: string }> = [
  { value: 'PER_SET',       label: '每套',   hint: '一套成品用这么多(套装单最常见)' },
  { value: 'PER_PIECE',     label: '每件',   hint: '一件衣服用这么多' },
  { value: 'PER_COMPONENT', label: '每部件', hint: '按部件计(如一条拉链 = 一个部件)' },
  { value: 'PER_ORDER',     label: '整单固定', hint: '整张单就用这么多,不随数量变(如版费/一次性物料)' },
];

const VALID = new Set<string>(BASIS_OPTIONS.map((o) => o.value));

/** 已确认 = 值存在且是我们认的口径。空字符串/未知值一律视为未确认。 */
export function isBasisConfirmed(basis: unknown): basis is QuantityBasis {
  return typeof basis === 'string' && VALID.has(basis);
}

/**
 * 历史记忆的键:物料名 + 规格。
 * 不含颜色/订单/款号 —— 同一块料换个颜色口径不会变。
 * 归一化:去空白、折叠内部空格、大小写不敏感(库里同一块料被打了 30 遍,写法各不相同)。
 */
export function materialBasisKey(materialName?: string | null, spec?: string | null): string {
  const n = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const name = n(materialName);
  if (!name) return '';
  const sp = n(spec);
  return sp ? `${name}¦${sp}` : name;
}

export interface BasisHistoryRow {
  material_name?: string | null;
  spec?: string | null;
  consumption_basis?: string | null;
  updated_at?: string | null;
}

export interface BasisSuggestion {
  basis: QuantityBasis;
  /** 'history' = 来自历史确认(UI 显示「每套(来自历史确认)」);没有历史就没有建议 */
  source: 'history';
  confirmedAt?: string | null;
}

/**
 * 从历史已确认的 BOM 行推荐口径。
 *
 * 铁律:**只认历史确认,绝不按物料名猜。**
 * 「主标」听起来像每套、「面料」听起来像每件 —— 这类联想恰恰是 1022977 翻倍那类事故的来源。
 * 没有历史 → 返回 null → 跟单必须确认一次。确认后自然长成主数据。
 *
 * 同一物料历史上出现过两种口径时(业务确实会变),取**最近一次确认**,并仍然显示来源让人复核。
 */
export function suggestBasisFromHistory(
  history: BasisHistoryRow[],
  materialName?: string | null,
  spec?: string | null,
): BasisSuggestion | null {
  const key = materialBasisKey(materialName, spec);
  if (!key) return null;

  let best: { basis: QuantityBasis; at: string } | null = null;
  for (const row of history || []) {
    if (!isBasisConfirmed(row?.consumption_basis)) continue;
    if (materialBasisKey(row.material_name, row.spec) !== key) continue;
    const at = String(row.updated_at ?? '');
    if (!best || at > best.at) best = { basis: row.consumption_basis, at };
  }
  if (!best) return null;
  return { basis: best.basis, source: 'history', confirmedAt: best.at || null };
}

/** 批量:一次给整张 BOM 出建议(key → 建议),避免逐行扫历史。 */
export function suggestBasisForBom<T extends { material_name?: string | null; spec?: string | null }>(
  bomRows: T[],
  history: BasisHistoryRow[],
): Map<string, BasisSuggestion> {
  const out = new Map<string, BasisSuggestion>();
  for (const r of bomRows || []) {
    const key = materialBasisKey(r.material_name, r.spec);
    if (!key || out.has(key)) continue;
    const s = suggestBasisFromHistory(history, r.material_name, r.spec);
    if (s) out.set(key, s);
  }
  return out;
}

// ── Procurement Draft 就绪门禁 ────────────────────────────────

export const NEEDS_BOM_CONFIRMATION = 'NEEDS_BOM_CONFIRMATION' as const;

export interface BasisReadiness {
  ready: boolean;
  /** 未确认口径的物料名(去重,给 UI 直接列出来让跟单去补) */
  unconfirmed: string[];
  /** 展示状态:未就绪时是 NEEDS_BOM_CONFIRMATION */
  status: typeof NEEDS_BOM_CONFIRMATION | 'READY';
}

/**
 * Procurement Draft 能不能进 Confirm Purchase。
 *
 * CEO 定的流程:
 *   BOM → basis confirmed? ─ No → NEEDS_BOM_CONFIRMATION(草稿照出,但不许确认采购)
 *                          └ Yes → Material Requirement → Procurement Draft
 *
 * 注意:草稿**允许**生成 —— 让采购先看到要买什么、可以先去问价;
 * 卡的是「确认采购」这一步,因为那一步产生的是对供应商的真实承诺。
 */
export function checkBasisReadiness(
  bomRows: Array<{ material_name?: string | null; consumption_basis?: string | null }>,
): BasisReadiness {
  const unconfirmed: string[] = [];
  const seen = new Set<string>();
  for (const r of bomRows || []) {
    if (isBasisConfirmed(r?.consumption_basis)) continue;
    const name = String(r?.material_name ?? '').trim() || '(未命名物料)';
    if (seen.has(name)) continue;
    seen.add(name);
    unconfirmed.push(name);
  }
  const ready = unconfirmed.length === 0;
  return { ready, unconfirmed, status: ready ? 'READY' : NEEDS_BOM_CONFIRMATION };
}
