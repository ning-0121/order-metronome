/**
 * 面料应付「防双付」契约测试(2026-07-20 全链审计 · 红线②)。
 * 运行:npx tsx scripts/test-fabric-payable-channel-contract.ts
 *
 * 锁定不变量:
 *  1. 分类器闸口径不变:FABRIC_CANONICAL 精确命中(含前后空格/大小写)。
 *  2. 分类器盲区被文档化:类别 null/空/疑似面料但未精确命中 → 判盲区(双付高危信号)。
 *  3. 跨渠道双应付侦测器契约:同一(供应商,订单)两渠道共现→冲突;单渠道→无;PR侧有盲区行→high。
 *
 * 为什么只侦测不硬阻断:两渠道无共同物理批次键,(供应商+订单) 会有合法双渠道场景(面料走LG+辅料走PR),
 * 硬去重会误杀合法辅料付款=漏付。见 lib/procurement/fabric-payable-guard.ts 头注。
 */

import { isFabricCategory } from '../lib/services/procurement-execution';
import {
  isFabricClassifierBlindSpot,
  detectCrossChannelPayableConflicts,
  type ChannelPayableRef,
  type ReconLineRef,
} from '../lib/procurement/fabric-payable-guard';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── 1. 分类器闸口径(canonical 恒命中,含空格/大小写) ──
section('分类器闸:canonical 命中不变');
for (const c of ['面料', '布料', '主料', 'fabric', 'main_fabric', '  面料 ', 'FABRIC', 'Main_Fabric']) {
  assert(isFabricCategory(c) === true, `isFabricCategory("${c}") = true`);
}
for (const c of ['辅料', '包装', '拉链', 'trim', 'zipper']) {
  assert(isFabricCategory(c) === false, `isFabricCategory("${c}") = false(非面料不误排)`);
}

// ── 2. 分类器盲区被文档化(这些"疑似面料却未被精确命中" → 双付高危盲区) ──
section('分类器盲区文档化(回归可见)');
for (const c of ['针织布', '梭织面料', '氨纶面布', 'main fabric', 'shell fabric', null, '', '   ']) {
  assert(isFabricClassifierBlindSpot(c) === true, `盲区: ${JSON.stringify(c)} → true(疑似面料/无类别未被排除)`);
  // 同时证明:这些盲区当前【不会】被 isFabricCategory 排除 → 会泄漏进 PR 对账 → 与 LG 双付
  assert(isFabricCategory(c) === false, `  └ 盲区 ${JSON.stringify(c)} 当前 isFabricCategory=false(会泄漏,故需侦测)`);
}
for (const c of ['辅料', '拉链', '包装', 'trim']) {
  assert(isFabricClassifierBlindSpot(c) === false, `非盲区: "${c}" → false(纯辅料,不误报)`);
}
// canonical 已被正确排除 → 不算盲区(不重复告警)
for (const c of ['面料', 'fabric']) {
  assert(isFabricClassifierBlindSpot(c) === false, `canonical "${c}" 非盲区(已正确排除)`);
}

// ── 3. 跨渠道双应付侦测器契约 ──
section('跨渠道双应付侦测');
const L = (s: string, o: string): ChannelPayableRef => ({ supplierId: s, orderKey: o });
const RL = (s: string, o: string, category: string | null): ReconLineRef => ({ supplierId: s, orderKey: o, category });

// 3a 单渠道 → 无冲突
{
  const c = detectCrossChannelPayableConflicts([L('supA', 'ORD1')], [], []);
  assert(c.length === 0, '仅 LG 有应付 → 无冲突');
}
{
  const c = detectCrossChannelPayableConflicts([], [L('supA', 'ORD1')], [RL('supA', 'ORD1', '辅料')]);
  assert(c.length === 0, '仅 PR 有应付 → 无冲突');
}

// 3b 两渠道共现 + PR 侧全是辅料(合法:面料走LG + 辅料走PR) → warn(不阻断)
{
  const c = detectCrossChannelPayableConflicts(
    [L('supA', 'ORD1')], [L('supA', 'ORD1')], [RL('supA', 'ORD1', '拉链'), RL('supA', 'ORD1', '包装')],
  );
  assert(c.length === 1 && c[0].severity === 'warn', '共现+PR全辅料 → warn(合法双渠道,不误杀)', JSON.stringify(c));
  assert(c[0].blindSpotCategories.length === 0, 'warn 无盲区类别');
}

// 3c 两渠道共现 + PR 侧有盲区行(疑似泄漏面料) → high
{
  const c = detectCrossChannelPayableConflicts(
    [L('supA', 'ORD1')], [L('supA', 'ORD1')], [RL('supA', 'ORD1', '针织布'), RL('supA', 'ORD1', '拉链')],
  );
  assert(c.length === 1 && c[0].severity === 'high', '共现+PR有盲区(针织布) → high(双付高危)', JSON.stringify(c));
  assert(c[0].blindSpotCategories.includes('针织布'), 'high 标出盲区类别 针织布');
}

// 3d null 类别行也升级 high(无类别无法排除)
{
  const c = detectCrossChannelPayableConflicts(
    [L('supB', 'ORD9')], [L('supB', 'ORD9')], [RL('supB', 'ORD9', null)],
  );
  assert(c.length === 1 && c[0].severity === 'high' && c[0].blindSpotCategories.includes('∅'), 'PR 侧 null 类别 → high(∅)', JSON.stringify(c));
}

// 3e 不同订单不误合并
{
  const c = detectCrossChannelPayableConflicts(
    [L('supA', 'ORD1')], [L('supA', 'ORD2')], [RL('supA', 'ORD2', null)],
  );
  assert(c.length === 0, '同供应商不同订单 → 不共现,无冲突');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
