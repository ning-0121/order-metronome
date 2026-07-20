/**
 * 面料应付防双付守卫(2026-07-20 全链审计 · 红线②)。
 *
 * 背景:面料应付本应只走「供应商对账台账 LG」,系统 PO 对账(PR/DP)靠 `isFabricCategory` 把面料行排除。
 * 但两条付款渠道在物理批次层面**没有共同键**(LG 是导入手工账,purchase_order_id=null、无 line_item_id;
 * PR 有 PO 行),唯一重叠的只有 (供应商 + 订单),而这个键太粗——同一供应商可以合法地既供面料(走 LG)
 * 又供辅料(走 PR)给同一订单。因此**硬去重/硬阻断会误杀合法辅料付款 = 漏付**。
 *
 * 结论:防双付只能靠 `isFabricCategory` 这一个脆弱分类器(漏判→双付,误判→漏付),
 * 加上本模块的「侦测告警」——不阻断,只把"同一(供应商,订单)在两渠道都产生应付、且 PR 侧存在
 * 分类器盲区(类别 null/空/疑似面料却未被排除)的行"标为高优,发给人复核。
 *
 * 纯函数,可契约测试(见 scripts/test-fabric-payable-channel-contract.ts)。
 */

/** 对账/PO 侧一行的最小信息(用于判分类器盲区) */
export interface ReconLineRef {
  supplierId: string;
  orderKey: string;          // 归一化的 (内部)订单号
  category: string | null;
}

/** 某渠道已产生的一条应付的最小信息 */
export interface ChannelPayableRef {
  supplierId: string;
  orderKey: string;
}

export interface CrossChannelConflict {
  supplierId: string;
  orderKey: string;
  /** high = PR 侧存在分类器盲区行(疑似泄漏面料,双付高危);warn = 仅两渠道共现(可能是合法面料+辅料) */
  severity: 'high' | 'warn';
  blindSpotCategories: string[];   // 触发 high 的盲区类别(null 记为 '∅')
}

const FABRIC_CANONICAL = new Set(['面料', '布料', '主料', 'fabric', 'main_fabric']);
/** 疑似面料 token —— 仅用于「提示/告警」,绝不用于付款排除决策(避免把辅料误判成面料→漏付) */
const FABRIC_HINT_TOKENS = ['面料', '面布', '布', '纱', '梭织', '针织', 'fabric', 'woven', 'knit'];

/** 归一化类别:trim + lower。 */
function norm(category?: string | null): string {
  return String(category ?? '').trim().toLowerCase();
}

/**
 * 分类器盲区:某类别「疑似面料」但没被 `isFabricCategory`(精确匹配 FABRIC_CANONICAL)命中。
 * 命中盲区 = 面料很可能泄漏进了 PR 对账 → 与 LG 双付高危。
 * 注:null/空 也算盲区(无类别的行无法判定,保守视为高危)。
 */
export function isFabricClassifierBlindSpot(category?: string | null): boolean {
  const c = norm(category);
  if (c === '') return true;                 // 无类别 → 无法排除,保守判盲区
  if (FABRIC_CANONICAL.has(c)) return false; // 已被正确分类排除,非盲区
  return FABRIC_HINT_TOKENS.some((t) => c.includes(t.toLowerCase())); // 疑似面料却没被精确命中 → 盲区
}

/**
 * 跨渠道双应付侦测(纯函数)。
 * @param ledger LG 台账已推的应付
 * @param pr     PR/DP 对账已推的应付
 * @param reconLines PR 侧对账行(带 category,用于判盲区)
 * @returns 每个 (供应商,订单) 的冲突;severity=high 表示 PR 侧有盲区行(双付高危)
 */
export function detectCrossChannelPayableConflicts(
  ledger: ChannelPayableRef[],
  pr: ChannelPayableRef[],
  reconLines: ReconLineRef[],
): CrossChannelConflict[] {
  const key = (s: string, o: string) => `${s}¦${o}`;
  const ledgerKeys = new Set(ledger.map((l) => key(l.supplierId, l.orderKey)));
  const prKeys = new Set(pr.map((p) => key(p.supplierId, p.orderKey)));

  // PR 侧盲区行按 (供应商,订单) 归集
  const blindByKey = new Map<string, string[]>();
  for (const line of reconLines) {
    if (!isFabricClassifierBlindSpot(line.category)) continue;
    const k = key(line.supplierId, line.orderKey);
    const label = norm(line.category) === '' ? '∅' : String(line.category);
    const arr = blindByKey.get(k) || [];
    if (!arr.includes(label)) arr.push(label);
    blindByKey.set(k, arr);
  }

  const conflicts: CrossChannelConflict[] = [];
  for (const k of ledgerKeys) {
    if (!prKeys.has(k)) continue;   // 只有两渠道都产生应付才算共现
    const [supplierId, orderKey] = k.split('¦');
    const blind = blindByKey.get(k) || [];
    conflicts.push({
      supplierId,
      orderKey,
      severity: blind.length > 0 ? 'high' : 'warn',
      blindSpotCategories: blind,
    });
  }
  // high 在前,便于告警优先展示
  return conflicts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}
